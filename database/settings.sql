-- Migration: participant_settings
-- Builds the "Settings" section of the MVP PRD: per-channel consent (email, text, phone) on verified contacts,
-- phone verification recorded through a server-only proof, per-channel monthly caps, pause with an automatic
-- resume date, the weekly-alert opt-in, report recipients, phone removal, and self-service account deletion.
-- Apply after base-schema.sql, account-onboarding.sql and signup-terms.sql. Not yet applied to the hosted
-- project; see docs/accounts.md ("Settings").

create extension if not exists pgcrypto with schema extensions;

alter table public.user_preferences
 add column email_cap_per_month int not null default 4 check(email_cap_per_month between 0 and 7),
 add column text_cap_per_month int not null default 4 check(text_cap_per_month between 0 and 7),
 add column call_cap_per_month int not null default 2 check(call_cap_per_month between 0 and 7),
 add column paused_until date,
 add column alerts_opt_in boolean not null default false;
alter table public.user_contacts
 add column verification_method text check(verification_method in ('otp_sms','otp_call','invite_token','auth_email')),
 add column suppressed_at timestamptz,
 add column suppression_reason text check(suppression_reason in ('removed_by_user','stop_received','bounced','admin'));

-- Who else receives a participant's monthly report. unsubscribe_token_hash is filled by the report job when it sends.
create table public.report_recipients (
 id uuid primary key default gen_random_uuid(),
 participant_user_id uuid not null references auth.users(id) on delete cascade,
 email text not null check(length(email) between 3 and 254),
 name text not null check(length(trim(name)) between 1 and 100),
 added_by_user_id uuid not null references auth.users(id) on delete cascade,
 added_at timestamptz not null default now(), removed_at timestamptz,
 unsubscribe_token_hash text
);
create index report_recipients_participant_idx on public.report_recipients(participant_user_id) where removed_at is null;
create unique index report_recipients_active_idx on public.report_recipients(participant_user_id,lower(email)) where removed_at is null;
alter table public.report_recipients enable row level security;
revoke all on public.report_recipients from public, anon, authenticated;
grant all on public.report_recipients to service_role;
grant select on public.report_recipients to authenticated;
create policy own_read on public.report_recipients for select to authenticated using(participant_user_id=(select auth.uid()));

-- Self-service deletion: a request now, the hard delete by the scheduled cleanup job 30 days later unless cancelled.
create table public.account_deletions (
 user_id uuid primary key references auth.users(id) on delete cascade,
 requested_at timestamptz not null default now(),
 cancelled_at timestamptz
);
alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from public, anon, authenticated;
grant all on public.account_deletions to service_role;
grant select on public.account_deletions to authenticated;
create policy own_read on public.account_deletions for select to authenticated using(user_id=(select auth.uid()));

-- Server-only secrets read by the privileged helper. Phone verification is confirmed by the Netlify function
-- (Twilio Verify) and recorded here only with an HMAC proof over (user, contact, method) under this secret, so
-- a signed-in user cannot mark their own number verified by calling the RPC directly.
-- After applying: insert into safekeep_private.secrets values ('phone_verify_proof','<the PHONE_VERIFY_SECRET value>');
create table safekeep_private.secrets (name text primary key, value text not null);
revoke all on safekeep_private.secrets from public, anon, authenticated;

create or replace function safekeep_private.account_action(action text, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid(); identity auth.users; contact public.user_contacts; prefs public.user_preferences;
 cid uuid; channel_name text; choice text; first text; dob date; tz text; phone text;
 doc text; accepted timestamptz; inserted int := 0;
 secret text; method text; expected text; resume date; rid uuid; grants record;
 consent_version constant text := 'practice-consent-2026-10-29';
begin
 if uid is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into identity from auth.users where id=uid and deleted_at is null;
 if not found or identity.email_confirmed_at is null or identity.is_anonymous then
  raise exception 'Verify your email first' using errcode='42501';
 end if;
 if action='profile' then
  first := trim(payload->>'first_name');
  if first is null or length(first) not between 1 and 100 then raise exception 'Enter your first name'; end if;
  if payload->>'adult_confirmed' is distinct from 'true' then raise exception 'Confirm you are at least 18'; end if;
  dob := nullif(payload->>'date_of_birth','')::date;
  if dob is not null and (dob> (current_date - interval '18 years')::date or dob<date '1900-01-01') then raise exception 'Enter an adult date of birth or leave it blank'; end if;
  tz := payload->>'timezone';
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=tz) then raise exception 'Choose a valid timezone'; end if;
  insert into public.user_profiles(user_id,first_name,last_name,preferred_name,date_of_birth,timezone,adult_confirmed_at)
  values(uid,first,nullif(trim(payload->>'last_name'),''),nullif(trim(payload->>'preferred_name'),''),dob,tz,now())
  on conflict(user_id) do update set first_name=excluded.first_name,last_name=excluded.last_name,
   preferred_name=excluded.preferred_name,date_of_birth=excluded.date_of_birth,timezone=excluded.timezone,
   adult_confirmed_at=coalesce(public.user_profiles.adult_confirmed_at,now());
  insert into public.user_preferences(user_id) values(uid) on conflict do nothing;
 elsif action='sync_email' then
  -- Authority is auth.users, never the request payload or user-editable metadata.
  insert into public.user_contacts(user_id,kind,normalized_value,verified_at,verification_method)
  values(uid,'email',lower(identity.email),identity.email_confirmed_at,'auth_email')
  on conflict(user_id,kind,normalized_value) do update set verified_at=excluded.verified_at,verification_method='auth_email';
  update public.user_contacts set verified_at=null where user_id=uid and kind='email' and normalized_value<>lower(identity.email);
 elsif action='accept_policies' then
  if payload->>'source' is null or payload->>'source' not in ('signup','invite_accept','checkout','reprompt') then raise exception 'Choose where the terms were accepted'; end if;
  if payload->>'version' is null or length(payload->>'version') not between 1 and 40 then raise exception 'Check the policy version'; end if;
  if jsonb_typeof(payload->'documents') is distinct from 'array' or jsonb_array_length(payload->'documents') not between 1 and 3 then raise exception 'Choose the documents accepted'; end if;
  accepted := coalesce((payload->>'accepted_at')::timestamptz, now());
  if accepted > now() or accepted < now() - interval '90 days' then accepted := now(); end if;
  for doc in select jsonb_array_elements_text(payload->'documents') loop
   if doc not in ('terms','privacy','practice_consent') then raise exception 'Choose the documents accepted'; end if;
   insert into public.policy_acceptances(user_id,document,version,accepted_at,ip_hash,user_agent,source)
   values(uid,doc,payload->>'version',accepted,left(payload->>'ip_hash',128),left(payload->>'user_agent',512),payload->>'source')
   on conflict(user_id,document,version,source) do nothing;
   if found then inserted := inserted + 1; end if;
  end loop;
  return jsonb_build_object('saved',true,'recorded',inserted);
 elsif action='add_phone' then
  phone := payload->>'phone';
  if phone is null or phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Use international format, for example +12125551234'; end if;
  if payload->>'kind' is null or payload->>'kind' not in ('mobile','home','office','other') then raise exception 'Choose a phone type'; end if;
  if length(coalesce(payload->>'label',''))>80 or length(coalesce(payload->>'extension',''))>10 or coalesce(payload->>'extension','') !~ '^[0-9]*$' then raise exception 'Check phone label and extension'; end if;
  insert into public.user_contacts(user_id,kind,normalized_value,label,extension)
  values(uid,payload->>'kind',phone,nullif(payload->>'label',''),nullif(payload->>'extension',''));
 elsif action='verify_phone' then
  -- Only the Netlify function holds the proof secret; it calls this after Twilio Verify approves the code.
  select value into secret from safekeep_private.secrets where name='phone_verify_proof';
  if secret is null then raise exception 'Phone verification is not configured'; end if;
  method := payload->>'method';
  if method is null or method not in ('otp_sms','otp_call') then raise exception 'Choose a verification method'; end if;
  cid := (payload->>'contact_id')::uuid;
  select * into contact from public.user_contacts where id=cid and user_id=uid for update;
  if not found then raise exception 'Contact not found' using errcode='42501'; end if;
  if contact.kind='email' then raise exception 'Choose a phone contact'; end if;
  expected := encode(extensions.hmac(convert_to(uid::text||':'||cid::text||':'||method,'UTF8'),convert_to(secret,'UTF8'),'sha256'),'hex');
  if payload->>'proof' is distinct from expected then raise exception 'Verification was not accepted' using errcode='42501'; end if;
  update public.user_contacts set verified_at=now(),verification_method=method,suppressed_at=null,suppression_reason=null where id=cid;
 elsif action='remove_phone' then
  -- The row stays (consent history points at it); it is suppressed, its consents withdrawn, its queue cancelled.
  cid := (payload->>'contact_id')::uuid;
  select * into contact from public.user_contacts where id=cid and user_id=uid for update;
  if not found then raise exception 'Contact not found' using errcode='42501'; end if;
  if contact.kind='email' then raise exception 'Choose a phone contact'; end if;
  for grants in
   select distinct on (e.channel) e.channel, e.action from public.consent_events e where e.contact_id=cid and e.user_id=uid order by e.channel, e.sequence desc
  loop
   if grants.action='grant' then
    insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values(uid,cid,grants.channel,'revoke',consent_version,'account-settings');
   end if;
  end loop;
  update public.user_practices set delivery_status='cancelled' where user_id=uid and destination_contact_id=cid and delivery_status in ('scheduled','queued');
  update public.user_contacts set suppressed_at=now(),suppression_reason='removed_by_user' where id=cid;
 elsif action='consent' then
  cid := (payload->>'contact_id')::uuid; channel_name:=payload->>'channel'; choice:=payload->>'action';
  if choice is null or choice not in ('grant','revoke') then raise exception 'Choose grant or revoke'; end if;
  if channel_name is null or channel_name not in ('email','text','phone') then raise exception 'Choose a channel'; end if;
  select * into contact from public.user_contacts where id=cid and user_id=uid for update;
  if not found then raise exception 'Contact not found' using errcode='42501'; end if;
  if channel_name='email' and contact.kind<>'email' then raise exception 'Choose an email contact'; end if;
  if channel_name='text' and contact.kind<>'mobile' then raise exception 'Text practice needs a cell number'; end if;
  if channel_name='phone' and contact.kind='email' then raise exception 'Choose a phone contact'; end if;
  if choice='grant' then
   if channel_name='email' and (contact.verified_at is null or contact.normalized_value<>lower(identity.email)) then raise exception 'Verify this email first'; end if;
   if channel_name<>'email' and (contact.verified_at is null or contact.suppressed_at is not null) then raise exception 'Verify this number first'; end if;
   if not exists(select 1 from public.user_profiles where user_id=uid and adult_confirmed_at is not null) then raise exception 'Finish your profile first'; end if;
   if exists(select 1 from public.account_deletions where user_id=uid and cancelled_at is null) then raise exception 'Keep your account first'; end if;
  end if;
  insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source)
  values(uid,cid,channel_name,choice,consent_version,case when payload->>'source'='invite-accept' then 'invite-accept' else 'account-settings' end);
  if choice='revoke' then
   update public.user_practices set delivery_status='cancelled' where user_id=uid and destination_contact_id=cid and delivery_status in ('scheduled','queued');
  end if;
 elsif action='preferences' then
  if jsonb_typeof(payload->'practice_enabled') is distinct from 'boolean' then raise exception 'Choose practice status'; end if;
  if (payload->>'practice_enabled')::boolean and not exists(
   select 1 from public.user_contacts c where c.user_id=uid and c.verified_at is not null and c.suppressed_at is null
   and exists(select 1 from (select distinct on (e.channel) e.action from public.consent_events e where e.contact_id=c.id order by e.channel, e.sequence desc) latest where latest.action='grant')
  ) then raise exception 'Give consent for a verified contact before enabling practices'; end if;
  resume := nullif(payload->>'paused_until','')::date;
  if resume is not null and (resume < current_date or resume > current_date + 365) then raise exception 'Choose a resume date within the next year'; end if;
  select * into prefs from public.user_preferences where user_id=uid;
  insert into public.user_preferences(user_id,practice_enabled,max_practices_per_week,quiet_hours_start,quiet_hours_end,email_cap_per_month,text_cap_per_month,call_cap_per_month,paused_until,alerts_opt_in)
  values(uid,(payload->>'practice_enabled')::boolean,(payload->>'max_practices_per_week')::int,(payload->>'quiet_hours_start')::time,(payload->>'quiet_hours_end')::time,
   coalesce((payload->>'email_cap_per_month')::int,prefs.email_cap_per_month,4),coalesce((payload->>'text_cap_per_month')::int,prefs.text_cap_per_month,4),coalesce((payload->>'call_cap_per_month')::int,prefs.call_cap_per_month,2),
   resume,coalesce((payload->>'alerts_opt_in')::boolean,prefs.alerts_opt_in,false))
  on conflict(user_id) do update set practice_enabled=excluded.practice_enabled,max_practices_per_week=excluded.max_practices_per_week,quiet_hours_start=excluded.quiet_hours_start,quiet_hours_end=excluded.quiet_hours_end,
   email_cap_per_month=excluded.email_cap_per_month,text_cap_per_month=excluded.text_cap_per_month,call_cap_per_month=excluded.call_cap_per_month,paused_until=excluded.paused_until,alerts_opt_in=excluded.alerts_opt_in;
  if not (payload->>'practice_enabled')::boolean then
   update public.user_practices set delivery_status='cancelled' where user_id=uid and delivery_status in ('scheduled','queued');
  elsif resume is not null then
   update public.user_practices set delivery_status='cancelled' where user_id=uid and delivery_status in ('scheduled','queued') and scheduled_at < resume::timestamptz;
  end if;
 elsif action='add_report_recipient' then
  first := trim(payload->>'name');
  if first is null or length(first) not between 1 and 100 then raise exception 'Enter their name'; end if;
  if payload->>'email' is null or payload->>'email' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(payload->>'email')>254 then raise exception 'Enter a valid email address'; end if;
  if (select count(*) from public.report_recipients where participant_user_id=uid and removed_at is null) >= 5 then raise exception 'Up to five people can receive your report'; end if;
  if exists(select 1 from public.report_recipients where participant_user_id=uid and removed_at is null and lower(email)=lower(payload->>'email')) then raise exception 'That person already receives your report'; end if;
  insert into public.report_recipients(participant_user_id,email,name,added_by_user_id) values(uid,lower(trim(payload->>'email')),first,uid);
 elsif action='remove_report_recipient' then
  rid := (payload->>'recipient_id')::uuid;
  update public.report_recipients set removed_at=now() where id=rid and participant_user_id=uid and removed_at is null;
  if not found then raise exception 'Contact not found' using errcode='42501'; end if;
 elsif action='request_deletion' then
  -- Practice stops now; the account and its history go 30 days later unless the person keeps it.
  insert into public.account_deletions(user_id) values(uid) on conflict(user_id) do update set requested_at=now(),cancelled_at=null;
  for grants in
   select distinct on (e.contact_id,e.channel) e.contact_id, e.channel, e.action from public.consent_events e where e.user_id=uid order by e.contact_id, e.channel, e.sequence desc
  loop
   if grants.action='grant' then
    insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values(uid,grants.contact_id,grants.channel,'revoke',consent_version,'account-deletion');
   end if;
  end loop;
  update public.user_preferences set practice_enabled=false where user_id=uid;
  update public.user_practices set delivery_status='cancelled' where user_id=uid and delivery_status in ('scheduled','queued');
  update public.report_recipients set removed_at=now() where participant_user_id=uid and removed_at is null;
  return jsonb_build_object('saved',true,'delete_after',(now() + interval '30 days'));
 elsif action='cancel_deletion' then
  update public.account_deletions set cancelled_at=now() where user_id=uid and cancelled_at is null;
  if not found then raise exception 'No deletion is pending'; end if;
 else raise exception 'Unknown account action';
 end if;
 return jsonb_build_object('saved',true);
end $$;
