-- Migration: signup_terms_acceptance
-- Adds the policy_acceptances table (Terms of Service, Privacy Policy, Practice
-- Consent notice) and the accept_policies action on account_action. Apply after
-- base-schema.sql and account-onboarding.sql. Not yet applied to the hosted
-- project; see docs/accounts.md.

create table public.policy_acceptances (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 document text not null check(document in ('terms','privacy','practice_consent')),
 version text not null check(length(version) between 1 and 40),
 accepted_at timestamptz not null default now(),
 ip_hash text check(length(ip_hash)<=128),
 user_agent text check(length(user_agent)<=512),
 source text not null check(source in ('signup','invite_accept','checkout','reprompt')),
 recorded_at timestamptz not null default now()
);
create index policy_acceptances_user_idx on public.policy_acceptances(user_id,document,accepted_at desc);
-- Append-only: the same person accepting the same version from the same place is recorded once.
create unique index policy_acceptances_once_idx on public.policy_acceptances(user_id,document,version,source);

alter table public.policy_acceptances enable row level security;
revoke all on public.policy_acceptances from public, anon, authenticated;
grant all on public.policy_acceptances to service_role;
grant select on public.policy_acceptances to authenticated;
create policy own_read on public.policy_acceptances for select to authenticated using(user_id=(select auth.uid()));

-- account_action gains accept_policies. The rest of the body is unchanged from account-onboarding.sql.
create or replace function safekeep_private.account_action(action text, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid(); identity auth.users; contact public.user_contacts;
 cid uuid; channel_name text; choice text; first text; dob date; tz text; phone text;
 doc text; accepted timestamptz; inserted int := 0;
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
  insert into public.user_contacts(user_id,kind,normalized_value,verified_at)
  values(uid,'email',lower(identity.email),identity.email_confirmed_at)
  on conflict(user_id,kind,normalized_value) do update set verified_at=excluded.verified_at;
  update public.user_contacts set verified_at=null where user_id=uid and kind='email' and normalized_value<>lower(identity.email);
 elsif action='accept_policies' then
  -- Records that this user accepted the named documents. The user can only ever record acceptance for
  -- themselves, and the same (document, version, source) is recorded once, so a replay changes nothing.
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
 elsif action='consent' then
  cid := (payload->>'contact_id')::uuid; channel_name:=payload->>'channel'; choice:=payload->>'action';
  if choice is null or choice not in ('grant','revoke') or channel_name is distinct from 'email' then raise exception 'Only email practice consent is available'; end if;
  select * into contact from public.user_contacts where id=cid and user_id=uid for update;
  if not found then raise exception 'Contact not found' using errcode='42501'; end if;
  if contact.kind<>'email' then raise exception 'Choose an email contact'; end if;
  if choice='grant' and (contact.verified_at is null or contact.normalized_value<>lower(identity.email)) then raise exception 'Verify this email first'; end if;
  if choice='grant' and not exists(select 1 from public.user_profiles where user_id=uid and adult_confirmed_at is not null) then raise exception 'Finish your profile first'; end if;
  insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source)
  values(uid,cid,channel_name,choice,'practice-consent-2026-10-18','account-settings');
  if choice='revoke' then
   update public.user_practices set delivery_status='cancelled' where user_id=uid and destination_contact_id=cid and delivery_status in ('scheduled','queued');
  end if;
 elsif action='preferences' then
  if jsonb_typeof(payload->'practice_enabled') is distinct from 'boolean' then raise exception 'Choose practice status'; end if;
  if (payload->>'practice_enabled')::boolean and not exists(
   select 1 from public.user_contacts c where c.user_id=uid and c.kind='email' and c.verified_at is not null and c.normalized_value=lower(identity.email)
   and (select e.action from public.consent_events e where e.contact_id=c.id and e.channel='email' order by e.sequence desc limit 1)='grant'
  ) then raise exception 'Give consent for a verified email before enabling practices'; end if;
  insert into public.user_preferences(user_id,practice_enabled,max_practices_per_week,quiet_hours_start,quiet_hours_end)
  values(uid,(payload->>'practice_enabled')::boolean,(payload->>'max_practices_per_week')::int,(payload->>'quiet_hours_start')::time,(payload->>'quiet_hours_end')::time)
  on conflict(user_id) do update set practice_enabled=excluded.practice_enabled,max_practices_per_week=excluded.max_practices_per_week,quiet_hours_start=excluded.quiet_hours_start,quiet_hours_end=excluded.quiet_hours_end;
  if not (payload->>'practice_enabled')::boolean then
   update public.user_practices set delivery_status='cancelled' where user_id=uid and delivery_status in ('scheduled','queued');
  end if;
 else raise exception 'Unknown account action';
 end if;
 return jsonb_build_object('saved',true);
end $$;
