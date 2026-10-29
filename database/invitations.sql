-- Migration: participant_invitations
-- Builds the "Gifting to a family member" section of the MVP PRD. A sponsor invites someone to a seat; the invited
-- person accepts with their own account, verified by Supabase like any other, and chooses their own channels. The
-- sponsor pays and sees outcome categories; they never consent for anyone and never see practice content.
-- Apply after billing-checkout.sql. Not yet applied to the hosted project; see docs/accounts.md ("Invitations").
--
-- Security model: the invite token only identifies the invitation. Acceptance requires a signed-in user whose
-- verified login email equals the invited address, so knowing a token (the sponsor can see their own outgoing links)
-- never lets anyone accept for someone else. No service-role key is needed on the request path.

-- A sponsor can also practise: the seat ledger holds one row per role.
alter table public.subscription_members drop constraint subscription_members_subscription_id_user_id_key;
alter table public.subscription_members add constraint subscription_members_one_row_per_role unique(subscription_id,user_id,role);
-- In the MVP a participant belongs to one plan at a time.
create unique index subscription_members_one_live_participant_idx on public.subscription_members(user_id) where role='participant' and status in ('active','paused');

create table public.participant_invitations (
 id uuid primary key default gen_random_uuid(),
 subscription_id uuid not null references public.subscriptions(id) on delete cascade,
 inviter_user_id uuid not null references auth.users(id) on delete cascade,
 invitee_email text not null check(length(invitee_email) between 3 and 254),
 invitee_name text not null check(length(trim(invitee_name)) between 1 and 80),
 invitee_phone text check(length(invitee_phone)<=32), -- used only to prefill; never texted
 personal_note text check(length(personal_note)<=500),
 token_hash text not null unique,
 expires_at timestamptz not null,
 accepted_at timestamptz, declined_at timestamptz, revoked_at timestamptz, expired_notified_at timestamptz,
 accepted_user_id uuid references auth.users(id) on delete set null,
 reminded_day3_at timestamptz, reminded_day10_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index participant_invitations_subscription_idx on public.participant_invitations(subscription_id);
create index participant_invitations_pending_idx on public.participant_invitations(expires_at) where accepted_at is null and declined_at is null and revoked_at is null;
alter table public.participant_invitations enable row level security;
revoke all on public.participant_invitations from public, anon, authenticated;
grant all on public.participant_invitations to service_role;
-- Sponsors read their own invitations (without the token hash, which no one reads).
grant select(id,subscription_id,inviter_user_id,invitee_email,invitee_name,invitee_phone,personal_note,expires_at,accepted_at,declined_at,revoked_at,accepted_user_id,created_at) on public.participant_invitations to authenticated;
create policy sponsor_read on public.participant_invitations for select to authenticated using(safekeep_private.sponsor_of(subscription_id)=(select auth.uid()));

-- The origin used in emailed links comes from here, never from a request, so a direct RPC caller cannot make
-- Safekeep email a link to somewhere else. After applying: insert into safekeep_private.secrets values ('app_origin','https://joinsafekeep.com');
create function safekeep_private.app_origin() returns text language sql stable security definer set search_path = '' as $$
 select coalesce((select value from safekeep_private.secrets where name='app_origin'),'https://joinsafekeep.com') $$;

-- Seats in use: participants on the plan plus invitations still waiting for an answer.
create function safekeep_private.seats_in_use(sid uuid) returns int language sql stable security definer set search_path = '' as $$
 select (select count(*) from public.subscription_members where subscription_id=sid and role='participant' and status in ('active','paused'))::int
      + (select count(*) from public.participant_invitations where subscription_id=sid and accepted_at is null and declined_at is null and revoked_at is null and expires_at>now())::int $$;

-- Entitlement now counts participant seats only; a sponsor practises only if they hold a participant row too.
create or replace function public.is_active_participant(who uuid) returns boolean language plpgsql security definer stable set search_path = '' as $$
begin
 if auth.uid() is not null and who is distinct from auth.uid() then raise exception 'Not allowed' using errcode='42501'; end if;
 return exists(
  select 1 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
  where m.user_id=who and m.role='participant' and m.status='active'
  and (s.status in ('active','trialing') or (s.status='past_due' and coalesce(s.past_due_since,now()) > now() - interval '7 days'))
 );
end $$;

create function safekeep_private.invite_email_body(sponsor text, invitee text, note text, link text) returns text language sql immutable as $$
 select 'Hello '||invitee||','||E'\n\n'||sponsor||' has given you a Safekeep plan and would like you to try it.'
  ||case when note is not null and length(trim(note))>0 then E'\n\nThey wrote: "'||trim(note)||'"' else '' end
  ||E'\n\n'||'Safekeep sends a realistic practice scam now and then, by email and, if you choose, by text or phone, and shows you the warning signs straight afterwards. Nothing is ever sent to you until you say yes, you choose how often, and you can stop at any time. '||sponsor||' won''t see your practice messages.'
  ||E'\n\n'||'To accept, open this link:'||E'\n'||link
  ||E'\n\n'||'If you would rather not, there is a "No thanks" button on the same page, and we will let '||sponsor||' know kindly. This invitation is good for 14 days.'
  ||E'\n\n'||'The Safekeep team' $$;

-- Everything a sponsor or an invited person does with invitations and seats.
create function safekeep_private.invitation_action(action text, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid(); identity auth.users; sub public.subscriptions; inv public.participant_invitations; mem public.subscription_members;
 token text; email text; nm text; sponsor_name text; who_name text; link text; seats_free int;
begin
 if uid is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into identity from auth.users where id=uid and deleted_at is null;
 if not found or identity.email_confirmed_at is null or identity.is_anonymous then raise exception 'Verify your email first' using errcode='42501'; end if;
 select coalesce(p.preferred_name,p.first_name) into sponsor_name from public.user_profiles p where p.user_id=uid;

 if action in ('invite','join_own_plan') then
  select * into sub from public.subscriptions where sponsor_user_id=uid and status in ('trialing','active','past_due') order by created_at desc limit 1 for update;
  if not found then raise exception 'Start a plan first'; end if;
  seats_free := sub.seats - safekeep_private.seats_in_use(sub.id);
  if seats_free < 1 then raise exception 'Every seat on your plan is in use'; end if;
 end if;

 if action='invite' then
  email := lower(trim(payload->>'invitee_email')); nm := trim(payload->>'invitee_name');
  if email is null or email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(email)>254 then raise exception 'Enter their email address'; end if;
  if nm is null or length(nm) not between 1 and 80 then raise exception 'Enter their first name'; end if;
  if email=lower(identity.email) then raise exception 'To practise yourself, choose Add myself'; end if;
  if length(coalesce(payload->>'personal_note',''))>500 then raise exception 'Keep the note under 500 characters'; end if;
  if exists(select 1 from public.participant_invitations where subscription_id=sub.id and lower(invitee_email)=email and accepted_at is null and declined_at is null and revoked_at is null and expires_at>now()) then raise exception 'That person already has an invitation waiting'; end if;
  token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.participant_invitations(subscription_id,inviter_user_id,invitee_email,invitee_name,invitee_phone,personal_note,token_hash,expires_at)
  values(sub.id,uid,email,nm,nullif(trim(payload->>'invitee_phone'),''),nullif(trim(payload->>'personal_note'),''),encode(extensions.digest(token,'sha256'),'hex'),now()+interval '14 days') returning * into inv;
  link := safekeep_private.app_origin()||'/invite/?t='||token;
  insert into public.outbound_emails(to_email,subject,body,kind) values(email,coalesce(sponsor_name,'Someone in your family')||' has given you Safekeep',safekeep_private.invite_email_body(coalesce(sponsor_name,'Someone in your family'),nm,inv.personal_note,link),'invitation');
  return jsonb_build_object('saved',true,'invitation_id',inv.id);

 elsif action='resend' then
  -- Rotates the token, so an older link stops working, and restarts the 14 days.
  select * into inv from public.participant_invitations i where i.id=(payload->>'invitation_id')::uuid and safekeep_private.sponsor_of(i.subscription_id)=uid for update;
  if not found then raise exception 'Invitation not found' using errcode='42501'; end if;
  if inv.accepted_at is not null or inv.declined_at is not null or inv.revoked_at is not null then raise exception 'That invitation is closed'; end if;
  token := encode(extensions.gen_random_bytes(32),'hex');
  update public.participant_invitations set token_hash=encode(extensions.digest(token,'sha256'),'hex'), expires_at=now()+interval '14 days', reminded_day3_at=null, reminded_day10_at=null, updated_at=now() where id=inv.id;
  link := safekeep_private.app_origin()||'/invite/?t='||token;
  insert into public.outbound_emails(to_email,subject,body,kind) values(inv.invitee_email,coalesce(sponsor_name,'Someone in your family')||' has given you Safekeep',safekeep_private.invite_email_body(coalesce(sponsor_name,'Someone in your family'),inv.invitee_name,inv.personal_note,link),'invitation');

 elsif action='revoke' then
  update public.participant_invitations i set revoked_at=now(), updated_at=now() where i.id=(payload->>'invitation_id')::uuid and safekeep_private.sponsor_of(i.subscription_id)=uid and accepted_at is null and declined_at is null and revoked_at is null;
  if not found then raise exception 'Invitation not found' using errcode='42501'; end if;

 elsif action='join_own_plan' then
  if exists(select 1 from public.subscription_members where user_id=uid and role='participant' and status in ('active','paused')) then raise exception 'You are already practising on a plan'; end if;
  insert into public.subscription_members(subscription_id,user_id,role,status) values(sub.id,uid,'participant','active')
  on conflict(subscription_id,user_id,role) do update set status='active', ended_at=null, joined_at=now();

 elsif action='remove_participant' then
  select m.* into mem from public.subscription_members m where m.id=(payload->>'member_id')::uuid and m.role='participant' and m.status in ('active','paused') and safekeep_private.sponsor_of(m.subscription_id)=uid for update;
  if not found then raise exception 'Participant not found' using errcode='42501'; end if;
  update public.subscription_members set status='removed', ended_at=now() where id=mem.id;
  update public.user_practices set delivery_status='cancelled' where user_id=mem.user_id and delivery_status in ('scheduled','queued');
  if mem.user_id<>uid then
   select u.email into email from auth.users u where u.id=mem.user_id;
   if email is not null then
    insert into public.outbound_emails(to_email,subject,body,kind) values(email,'Your Safekeep practice has stopped',
     'Hello,'||E'\n\n'||coalesce(sponsor_name,'The person who gave you Safekeep')||' has taken you off their Safekeep plan, so your practice messages have stopped. Your account, your settings and your history are still yours.'||E'\n\n'||'If you would like to keep practising, you can start your own plan at '||safekeep_private.app_origin()||'/account/.'||E'\n\n'||'The Safekeep team','participant_removed');
   end if;
  end if;

 elsif action='accept' then
  -- The invited person, signed in with the invited address verified, takes the seat.
  select * into inv from public.participant_invitations where token_hash=encode(extensions.digest(coalesce(payload->>'token',''),'sha256'),'hex') for update;
  if not found or inv.revoked_at is not null or inv.expires_at<=now() then raise exception 'This invitation has expired. Ask for a new one'; end if;
  if inv.declined_at is not null then raise exception 'This invitation was declined'; end if;
  if inv.accepted_at is not null then
   if inv.accepted_user_id=uid then return jsonb_build_object('saved',true,'already',true); end if;
   raise exception 'This invitation has already been used';
  end if;
  if lower(identity.email)<>lower(inv.invitee_email) then raise exception 'Sign in with the email address the invitation was sent to'; end if;
  select * into sub from public.subscriptions where id=inv.subscription_id;
  if sub.status not in ('trialing','active','past_due') then raise exception 'This plan is no longer active'; end if;
  if exists(select 1 from public.subscription_members where user_id=uid and role='participant' and status in ('active','paused')) then raise exception 'You are already practising on another plan. Leave it first from your account'; end if;
  insert into public.subscription_members(subscription_id,user_id,role,status) values(inv.subscription_id,uid,'participant','active')
  on conflict(subscription_id,user_id,role) do update set status='active', ended_at=null, joined_at=now();
  update public.participant_invitations set accepted_at=now(), accepted_user_id=uid, updated_at=now() where id=inv.id;
  select coalesce(p.preferred_name,p.first_name,inv.invitee_name) into who_name from public.user_profiles p where p.user_id=uid;
  select u.email into email from auth.users u where u.id=inv.inviter_user_id;
  if email is not null then
   insert into public.outbound_emails(to_email,subject,body,kind) values(email,coalesce(who_name,inv.invitee_name)||' accepted your Safekeep invitation',
    'Hello,'||E'\n\n'||coalesce(who_name,inv.invitee_name)||' accepted your invitation and has a Safekeep account now. They choose how practice reaches them (email, text, phone) and how often, and you will see which channels they picked on your account page. You won''t see the practice messages themselves.'||E'\n\n'||'The Safekeep team','invitation_accepted');
  end if;
  return jsonb_build_object('saved',true);
 else raise exception 'Unknown invitation action';
 end if;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function safekeep_private.invitation_action(text,jsonb) from public,anon;
grant execute on function safekeep_private.invitation_action(text,jsonb) to authenticated;
create function public.invitation_action(action text, payload jsonb default '{}') returns jsonb
language sql security invoker set search_path = '' as $$ select safekeep_private.invitation_action(action,payload); $$;
revoke all on function public.invitation_action(text,jsonb) from public,anon;
grant execute on function public.invitation_action(text,jsonb) to authenticated;

-- The invite page, before anyone signs in: what the invitation says, by token. Returns nothing for an unknown,
-- expired, revoked or answered token. The token is 256 random bits; there is nothing to enumerate.
create function public.invitation_by_token(token text) returns table(invitee_name text, invitee_email text, sponsor_name text, personal_note text, plan text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select i.invitee_name, i.invitee_email, coalesce(p.preferred_name,p.first_name,'Someone in your family'), i.personal_note, s.plan, i.expires_at
 from public.participant_invitations i join public.subscriptions s on s.id=i.subscription_id left join public.user_profiles p on p.user_id=i.inviter_user_id
 where i.token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at>now()
   and s.status in ('trialing','active','past_due') $$;
revoke all on function public.invitation_by_token(text) from public;
grant execute on function public.invitation_by_token(text) to anon, authenticated;

-- "No thanks" works without an account: frees the seat and tells the sponsor, kindly.
create function public.decline_invitation(token text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare inv public.participant_invitations; email text;
begin
 update public.participant_invitations set declined_at=now(), updated_at=now()
 where token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and accepted_at is null and declined_at is null and revoked_at is null and expires_at>now()
 returning * into inv;
 if not found then return jsonb_build_object('saved',false); end if;
 select u.email into email from auth.users u where u.id=inv.inviter_user_id;
 if email is not null then
  insert into public.outbound_emails(to_email,subject,body,kind) values(email,inv.invitee_name||' said no thanks to Safekeep for now',
   'Hello,'||E'\n\n'||inv.invitee_name||' has decided not to use Safekeep for now, so nothing will be sent to them. Their seat on your plan is free again, if there is someone else you would like to invite.'||E'\n\n'||'It can help to talk it through together first; the "Start a conversation" ideas on our homepage are a gentle way in.'||E'\n\n'||'The Safekeep team','invitation_declined');
 end if;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function public.decline_invitation(text) from public;
grant execute on function public.decline_invitation(text) to anon, authenticated;

-- The sponsor's view of their seats: participants with first name, status and the names of the channels they turned
-- on (never the number, the address or the schedule), plus invitations still out.
create function public.sponsor_seats() returns table(kind text, id uuid, name text, email text, status text, channels text[], since timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 with sub as (select id from public.subscriptions where sponsor_user_id=auth.uid() and status in ('trialing','active','past_due') order by created_at desc limit 1)
 select 'participant', m.id, coalesce(p.preferred_name,p.first_name,'Participant'), null::text, m.status,
  coalesce((select array_agg(distinct latest.channel order by latest.channel) from (
    select distinct on (e.contact_id,e.channel) e.channel, e.action from public.consent_events e where e.user_id=m.user_id order by e.contact_id,e.channel,e.sequence desc) latest where latest.action='grant'),'{}'),
  m.joined_at, null::timestamptz
 from public.subscription_members m join sub on sub.id=m.subscription_id left join public.user_profiles p on p.user_id=m.user_id
 where m.role='participant' and m.status in ('active','paused')
 union all
 select 'invitation', i.id, i.invitee_name, i.invitee_email, 'pending', '{}'::text[], i.created_at, i.expires_at
 from public.participant_invitations i join sub on sub.id=i.subscription_id
 where i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at>now() $$;
revoke all on function public.sponsor_seats() from public, anon;
grant execute on function public.sponsor_seats() to authenticated;

-- Outbound email kinds for this phase.
alter table public.outbound_emails drop constraint outbound_emails_kind_check;
alter table public.outbound_emails add constraint outbound_emails_kind_check check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed','invitation','invitation_accepted','invitation_declined','invitation_expired','invitation_reminder'));

-- When a plan ends, invitations still out are revoked and invitees are not contacted again.
create or replace function public.end_subscription(sid uuid, ended timestamptz default now()) returns jsonb language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions; member record; addr text; stopped int := 0; when_text text;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 select * into sub from public.subscriptions where id=sid for update;
 if not found then raise exception 'Subscription not found'; end if;
 update public.subscriptions set ended_at=coalesce(ended_at,ended), updated_at=now() where id=sid;
 update public.participant_invitations set revoked_at=now(), updated_at=now() where subscription_id=sid and accepted_at is null and declined_at is null and revoked_at is null;
 when_text := to_char(ended at time zone 'America/New_York','FMMonth FMDD, YYYY');
 for member in select m.*, u.email from public.subscription_members m join auth.users u on u.id=m.user_id where m.subscription_id=sid and m.status in ('active','paused') loop
  update public.subscription_members set status='ended', ended_at=ended where id=member.id;
  update public.user_practices set delivery_status='cancelled' where user_id=member.user_id and delivery_status in ('scheduled','queued');
  stopped := stopped + 1;
  if member.role='participant' and member.user_id<>sub.sponsor_user_id and member.email is not null then
   insert into public.outbound_emails(to_email,subject,body,kind) values(member.email,'Your Safekeep practice has stopped',
    'Hello,'||E'\n\n'||'The Safekeep plan you were on ended on '||when_text||', so your practice messages have stopped. Nothing else changes: your account, your settings and your history are still yours, and nothing will be sent to you unless a plan starts again.'||E'\n\n'||'If you would like to keep practising, you can start your own plan any time at '||safekeep_private.app_origin()||'/account/.'||E'\n\n'||'The Safekeep team','subscription_ended');
  end if;
 end loop;
 select email into addr from auth.users where id=sub.sponsor_user_id;
 if addr is not null then
  insert into public.outbound_emails(to_email,subject,body,kind) values(addr,'Your Safekeep plan has ended',
   'Hello,'||E'\n\n'||'Your Safekeep plan ended on '||when_text||'. Practice has stopped for everyone on it, and no further payments will be taken.'||E'\n\n'||'Accounts and history stay in place, so starting again later is one step at '||safekeep_private.app_origin()||'/account/. If this is a surprise, reply to this email and a person will help.'||E'\n\n'||'The Safekeep team','subscription_ended');
 end if;
 return jsonb_build_object('ended',true,'seats_stopped',stopped);
end $$;

-- my_sponsorship ignores the participant's own plan (a sponsor practising on their own plan is not "on someone
-- else's plan").
create or replace function public.my_sponsorship() returns table(subscription_id uuid, sponsor_name text, plan text, status text, current_period_end timestamptz, cancel_at timestamptz, member_status text, joined_at timestamptz)
language sql security definer stable set search_path = '' as $$
 select s.id, coalesce(p.preferred_name,p.first_name,'Your sponsor'), s.plan, s.status, s.current_period_end, s.cancel_at, m.status, m.joined_at
 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
 left join public.user_profiles p on p.user_id=s.sponsor_user_id
 where m.user_id=auth.uid() and m.role='participant' and m.status in ('active','paused') and s.sponsor_user_id<>auth.uid()
 order by m.joined_at desc limit 1 $$;
