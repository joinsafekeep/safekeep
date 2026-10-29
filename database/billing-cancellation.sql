-- Migration: subscriptions_and_cancellation
-- Builds the "Cancellation" section of the MVP PRD, with the slice of the billing layer it needs: a subscriptions
-- table fed by Stripe webhooks, the seat ledger (subscription_members), webhook idempotency, the price → seats
-- lookup, the entitlement check the scheduler will use, participant leave, and a queue for the plain emails that
-- go out when something stops. Apply after settings.sql. Not yet applied to the hosted project; see docs/accounts.md.

-- Seat counts keyed by Stripe price id, so a price change needs a row, not a deploy. Fill with the live price ids.
create table public.price_plans (
 price_id text primary key,
 plan text not null check(plan in ('individual','pairs','family')),
 billing text not null check(billing in ('monthly','annual')),
 seats int not null check(seats between 1 and 10),
 active boolean not null default true
);
alter table public.price_plans enable row level security;
revoke all on public.price_plans from public, anon, authenticated;
grant all on public.price_plans to service_role;

create table public.subscriptions (
 id uuid primary key default gen_random_uuid(),
 sponsor_user_id uuid not null references auth.users(id) on delete cascade,
 stripe_customer_id text not null,
 stripe_subscription_id text not null unique,
 price_id text, plan text check(plan in ('individual','pairs','family')), billing text check(billing in ('monthly','annual')),
 seats int not null default 1 check(seats between 1 and 10),
 status text not null check(status in ('incomplete','incomplete_expired','trialing','active','past_due','unpaid','paused','canceled')),
 current_period_end timestamptz, cancel_at timestamptz, canceled_at timestamptz, ended_at timestamptz,
 past_due_since timestamptz, refunded_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index subscriptions_sponsor_idx on public.subscriptions(sponsor_user_id, created_at desc);
create index subscriptions_customer_idx on public.subscriptions(stripe_customer_id);

create table public.subscription_members (
 id uuid primary key default gen_random_uuid(),
 subscription_id uuid not null references public.subscriptions(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('sponsor','participant')),
 status text not null default 'active' check(status in ('active','paused','left','removed','ended')),
 joined_at timestamptz not null default now(), ended_at timestamptz,
 unique(subscription_id,user_id)
);
create index subscription_members_user_idx on public.subscription_members(user_id) where status in ('active','paused');

create table public.webhook_events (
 id uuid primary key default gen_random_uuid(),
 provider text not null check(provider in ('stripe','twilio','email')),
 provider_event_id text not null,
 event_type text,
 received_at timestamptz not null default now(), processed_at timestamptz,
 payload jsonb,
 unique(provider,provider_event_id)
);

-- Plain emails written by the database or the webhook, sent by the scheduled sender (the only holder of the
-- email provider's key). One row per message; sent_at marks delivery to the provider.
create table public.outbound_emails (
 id uuid primary key default gen_random_uuid(),
 to_email text not null, subject text not null, body text not null,
 kind text not null check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed')),
 created_at timestamptz not null default now(), sent_at timestamptz, failed_at timestamptz, failure text
);
create index outbound_emails_pending_idx on public.outbound_emails(created_at) where sent_at is null and failed_at is null;

alter table public.subscriptions enable row level security;
alter table public.subscription_members enable row level security;
alter table public.webhook_events enable row level security;
alter table public.outbound_emails enable row level security;
revoke all on public.subscriptions, public.subscription_members, public.webhook_events, public.outbound_emails from public, anon, authenticated;
grant all on public.subscriptions, public.subscription_members, public.webhook_events, public.outbound_emails to service_role;

-- Helpers that answer "who sponsors this subscription" and "is this person on it" without the row policies
-- consulting each other (which Postgres would reject as recursive).
create function safekeep_private.sponsor_of(sid uuid) returns uuid language sql security definer stable set search_path = '' as $$
 select sponsor_user_id from public.subscriptions where id=sid $$;
create function safekeep_private.is_member(sid uuid, who uuid) returns boolean language sql security definer stable set search_path = '' as $$
 select exists(select 1 from public.subscription_members where subscription_id=sid and user_id=who) $$;
revoke all on function safekeep_private.sponsor_of(uuid), safekeep_private.is_member(uuid,uuid) from public, anon;
grant execute on function safekeep_private.sponsor_of(uuid), safekeep_private.is_member(uuid,uuid) to authenticated;

grant select on public.subscriptions to authenticated;
create policy sponsor_or_member_read on public.subscriptions for select to authenticated
 using(sponsor_user_id=(select auth.uid()) or safekeep_private.is_member(id,(select auth.uid())));
grant select on public.subscription_members to authenticated;
create policy self_or_sponsor_read on public.subscription_members for select to authenticated
 using(user_id=(select auth.uid()) or safekeep_private.sponsor_of(subscription_id)=(select auth.uid()));

-- The entitlement check the scheduler and the account page share. A participant is active when they hold an
-- active seat on a subscription that is active or trialing, or past due for less than seven days (dunning grace).
create function public.is_active_participant(who uuid) returns boolean language plpgsql security definer stable set search_path = '' as $$
begin
 if auth.uid() is not null and who is distinct from auth.uid() then raise exception 'Not allowed' using errcode='42501'; end if;
 return exists(
  select 1 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
  where m.user_id=who and m.status='active'
  and (s.status in ('active','trialing') or (s.status='past_due' and coalesce(s.past_due_since,now()) > now() - interval '7 days'))
 );
end $$;
revoke all on function public.is_active_participant(uuid) from public, anon;
grant execute on function public.is_active_participant(uuid) to authenticated, service_role;

-- Called by the Stripe webhook (service role) when a subscription ends: every seat goes inactive, queued practices
-- are cancelled, and sponsor and participants each get one plain email saying what stopped and when.
create function public.end_subscription(sid uuid, ended timestamptz default now()) returns jsonb language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions; member record; addr text; stopped int := 0; when_text text;
begin
 -- The grant below is what restricts this to the service role; this guard is a second line in case a grant drifts.
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 select * into sub from public.subscriptions where id=sid for update;
 if not found then raise exception 'Subscription not found'; end if;
 update public.subscriptions set ended_at=coalesce(ended_at,ended), updated_at=now() where id=sid;
 when_text := to_char(ended at time zone 'America/New_York','FMMonth FMDD, YYYY');
 for member in select m.*, u.email from public.subscription_members m join auth.users u on u.id=m.user_id where m.subscription_id=sid and m.status in ('active','paused') loop
  update public.subscription_members set status='ended', ended_at=ended where id=member.id;
  update public.user_practices set delivery_status='cancelled' where user_id=member.user_id and delivery_status in ('scheduled','queued');
  stopped := stopped + 1;
  if member.role='participant' and member.email is not null then
   insert into public.outbound_emails(to_email,subject,body,kind) values(member.email,'Your Safekeep practice has stopped',
    'Hello,'||E'\n\n'||'The Safekeep plan you were on ended on '||when_text||', so your practice messages have stopped. Nothing else changes: your account, your settings and your history are still yours, and nothing will be sent to you unless a plan starts again.'||E'\n\n'||'If you would like to keep practising, you can start your own plan any time at https://joinsafekeep.com/account/.'||E'\n\n'||'The Safekeep team','subscription_ended');
  end if;
 end loop;
 select email into addr from auth.users where id=sub.sponsor_user_id;
 if addr is not null then
  insert into public.outbound_emails(to_email,subject,body,kind) values(addr,'Your Safekeep plan has ended',
   'Hello,'||E'\n\n'||'Your Safekeep plan ended on '||when_text||'. Practice has stopped for everyone on it, and no further payments will be taken.'||E'\n\n'||'Accounts and history stay in place, so starting again later is one step at https://joinsafekeep.com/account/. If this is a surprise, reply to this email and a person will help.'||E'\n\n'||'The Safekeep team','subscription_ended');
 end if;
 return jsonb_build_object('ended',true,'seats_stopped',stopped);
end $$;
revoke all on function public.end_subscription(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.end_subscription(uuid,timestamptz) to service_role;

-- account_action gains leave_subscription: a participant leaves without the sponsor cancelling. The seat frees up
-- and the sponsor is told by email. Everything else in the body is unchanged from settings.sql.
create or replace function safekeep_private.account_action(action text, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid(); identity auth.users; contact public.user_contacts; prefs public.user_preferences;
 cid uuid; channel_name text; choice text; first text; dob date; tz text; phone text;
 doc text; accepted timestamptz; inserted int := 0;
 secret text; method text; expected text; resume date; rid uuid; grants record;
 member public.subscription_members; sponsor_email text; leaver text;
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
 elsif action='leave_subscription' then
  -- A participant leaves a plan someone else pays for. The seat frees up, their queue stops, the sponsor hears.
  select m.* into member from public.subscription_members m where m.user_id=uid and m.role='participant' and m.status in ('active','paused') order by m.joined_at desc limit 1 for update;
  if not found then raise exception 'You are not on someone else''s plan'; end if;
  update public.subscription_members set status='left', ended_at=now() where id=member.id;
  update public.user_practices set delivery_status='cancelled' where user_id=uid and delivery_status in ('scheduled','queued');
  select u.email into sponsor_email from public.subscriptions s join auth.users u on u.id=s.sponsor_user_id where s.id=member.subscription_id;
  select coalesce(p.preferred_name,p.first_name,'A participant') into leaver from public.user_profiles p where p.user_id=uid;
  if sponsor_email is not null then
   insert into public.outbound_emails(to_email,subject,body,kind) values(sponsor_email,coalesce(leaver,'A participant')||' has left your Safekeep plan',
    'Hello,'||E'\n\n'||coalesce(leaver,'A participant')||' has chosen to leave your Safekeep plan, so their practice messages have stopped. Their seat is free again, and you can invite someone else to it from your account at https://joinsafekeep.com/account/.'||E'\n\n'||'Your plan and payments are unchanged. If you would rather end the plan, Manage subscription on that page takes you to Stripe.'||E'\n\n'||'The Safekeep team','participant_left');
  end if;
 else raise exception 'Unknown account action';
 end if;
 return jsonb_build_object('saved',true);
end $$;

-- What a participant may know about the plan they are on: the sponsor's first name and the plan's state. Nothing
-- about billing, the customer, or other seats.
create function public.my_sponsorship() returns table(subscription_id uuid, sponsor_name text, plan text, status text, current_period_end timestamptz, cancel_at timestamptz, member_status text, joined_at timestamptz)
language sql security definer stable set search_path = '' as $$
 select s.id, coalesce(p.preferred_name,p.first_name,'Your sponsor'), s.plan, s.status, s.current_period_end, s.cancel_at, m.status, m.joined_at
 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
 left join public.user_profiles p on p.user_id=s.sponsor_user_id
 where m.user_id=auth.uid() and m.role='participant' and m.status in ('active','paused')
 order by m.joined_at desc limit 1 $$;
revoke all on function public.my_sponsorship() from public, anon;
grant execute on function public.my_sponsorship() to authenticated;
