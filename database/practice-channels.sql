-- Migration: practice_text_and_phone
-- Phases 6 and 7 of the MVP PRD ("Text practice", "Phone practice"): reply handling, STOP by text, REPORT, the
-- distress path, extra coaching links for replies and calls, call events with the in-call reveal, and the follow-up
-- reveal for anyone who hung up. Builds on practice.sql; apply after alerts.sql.

-- A practice can have more than one coaching link: the one in the message, plus one sent in reply to a text or after
-- a call. Each is stored only as a hash.
create table public.practice_links (
 token_hash text primary key, user_practice_id uuid not null references public.user_practices(id) on delete cascade,
 purpose text not null check(purpose in ('reply','call','reveal')), created_at timestamptz not null default now()
);
alter table public.practice_links enable row level security;
revoke all on public.practice_links from public, anon, authenticated;
grant all on public.practice_links to service_role;
alter table public.user_practices add column revealed_at timestamptz, add column reply_count int not null default 0;
alter table public.outbound_emails drop constraint outbound_emails_kind_check;
alter table public.outbound_emails add constraint outbound_emails_kind_check check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed','invitation','invitation_accepted','invitation_declined','invitation_expired','invitation_reminder','practice_paused','coaching_share','alerts_confirm','distress_alert','practice_reveal'));

create or replace function safekeep_private.practice_by_token(token text) returns public.user_practices language sql stable security definer set search_path = '' as $$
 select p.* from public.user_practices p where p.sent_at is not null and p.sent_at > now() - interval '30 days' and (
  p.access_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex')
  or p.id=(select l.user_practice_id from public.practice_links l where l.token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex'))) $$;

create function safekeep_private.new_link(pid uuid, why text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare tok text := encode(extensions.gen_random_bytes(24),'hex');
begin
 insert into public.practice_links(token_hash,user_practice_id,purpose) values(encode(extensions.digest(tok,'sha256'),'hex'),pid,why);
 return tok;
end $$;

create function safekeep_private.service_only() returns void language plpgsql stable set search_path = '' as $$
begin if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if; end $$;

-- Texts ---------------------------------------------------------------------------------------------------------------
-- The practice a text reply belongs to: the latest text practice sent to that number in the last seven days.
create function public.practice_for_text_reply(from_number text) returns table(practice_id uuid, user_id uuid, result text, first_name text, reply_keywords jsonb)
language sql stable security definer set search_path = '' as $$
 select p.id, p.user_id, p.result, coalesce(pf.preferred_name,pf.first_name), v.channel_variant->'reply_keywords'
 from public.user_practices p join public.user_contacts c on c.id=p.destination_contact_id join public.practice_scam_versions v on v.id=p.scam_version_id
 left join public.user_profiles pf on pf.user_id=p.user_id
 where p.channel='text' and c.normalized_value=from_number and p.delivery_status in ('sent','delivered') and p.sent_at > now() - interval '7 days'
 order by p.sent_at desc limit 1 $$;

-- STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) from a number: consent to practice texts on every contact with
-- that number is withdrawn and anything planned to it is cancelled. Never counted against the participant.
create function public.stop_texts_from(from_number text) returns int language plpgsql volatile security definer set search_path = '' as $$
declare c record; n int := 0; latest uuid;
begin
 perform safekeep_private.service_only();
 for c in select id, user_id from public.user_contacts where normalized_value=from_number and kind='mobile' loop
  if safekeep_private.has_grant(c.id,'text') then
   insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values(c.user_id,c.id,'text','revoke','practice-stop','text-stop');
   n := n + 1;
  end if;
  update public.user_practices set delivery_status='cancelled', cancel_reason='stopped by participant' where destination_contact_id=c.id and channel='text' and delivery_status in ('scheduled','queued');
  select id into latest from public.user_practices where destination_contact_id=c.id and channel='text' and sent_at is not null order by sent_at desc limit 1;
  if latest is not null then insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(latest,'stop_received',now(),'text-stop'); end if;
 end loop;
 return n;
end $$;

-- A reply to a practice text. kind: 'report' (REPORT: spotted it, the best outcome), 'reply' (anything else: a
-- practice opportunity), or 'distress' (fear or confusion, from the classifier: marked inconclusive, never
-- engaged, and every admin is emailed the same day). Returns a fresh coaching link for the reply message.
create function public.record_text_reply(pid uuid, kind text, message_sid text, reply_text text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices; tok text; who text; nm text; scam text;
begin
 perform safekeep_private.service_only();
 select * into p from public.user_practices where id=pid for update;
 if not found then return null; end if;
 -- Twilio can deliver the same webhook twice; the second time only issues a link.
 if message_sid is not null and exists(select 1 from public.practice_events where provider_event_id=message_sid) then
  return jsonb_build_object('token',safekeep_private.new_link(pid,'reply'),'result',p.result);
 end if;
 update public.user_practices set reply_count=reply_count+1 where id=pid;
 if kind='report' then
  if p.result in ('pending','no_observed_engagement') then update public.user_practices set result='reported', completed_at=coalesce(completed_at,now()) where id=pid; end if;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,provider_event_id,evidence_source) values(pid,'reported',now(),message_sid,'text-reply');
 elsif kind='distress' then
  update public.user_practices set result='inconclusive', completed_at=coalesce(completed_at,now()) where id=pid and result<>'reported';
  insert into public.practice_events(user_practice_id,event_type,occurred_at,provider_event_id,evidence_source) values(pid,'distress_flagged',now(),message_sid,'text-reply');
  select u.email, coalesce(pf.preferred_name,pf.first_name,'(no name)') into who, nm from auth.users u left join public.user_profiles pf on pf.user_id=u.id where u.id=p.user_id;
  select s.name into scam from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.id=p.scam_version_id;
  insert into public.outbound_emails(to_email,subject,body,kind)
  select u.email, 'Follow up today: a participant sounded worried',
   'A reply to a practice text read as worried or confused, so they were sent the reassurance message and the practice was marked inconclusive.'||E'\n\n'||'Participant: '||nm||' ('||coalesce(who,'no email')||')'||E'\n'||'Practice: '||coalesce(scam,'?')||E'\n'||'Their reply: '||left(coalesce(reply_text,''),500)||E'\n\n'||'Please get in touch with them today. Practice deliveries are on '||safekeep_private.app_origin()||'/admin/', 'distress_alert'
  from public.admin_users a join auth.users u on u.id=a.user_id where u.email is not null;
 else
  if p.result in ('pending','no_observed_engagement') then update public.user_practices set result='engaged', engaged_at=now() where id=pid; end if;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,provider_event_id,evidence_source) values(pid,'replied',now(),message_sid,'text-reply');
 end if;
 tok := safekeep_private.new_link(pid,'reply');
 return jsonb_build_object('token',tok,'result',(select result from public.user_practices where id=pid));
end $$;

-- Calls ---------------------------------------------------------------------------------------------------------------
-- What the voice webhook needs to run the script: only for a practice that was sent as a call and is still recent.
create function public.call_script(pid uuid) returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('practice_id',p.id,'script',v.channel_variant->'script','tells',v.tells,'next_steps',to_jsonb(v.next_steps),'revealed',p.revealed_at is not null,
  'can_text', exists(select 1 from public.user_contacts c where c.user_id=p.user_id and c.kind='mobile' and c.verified_at is not null and c.suppressed_at is null and safekeep_private.has_grant(c.id,'text')),
  'text_to', (select c.normalized_value from public.user_contacts c where c.user_id=p.user_id and c.kind='mobile' and c.verified_at is not null and c.suppressed_at is null and safekeep_private.has_grant(c.id,'text') order by c.created_at limit 1))
 from public.user_practices p join public.practice_scam_versions v on v.id=p.scam_version_id
 where p.id=pid and p.channel='phone' and p.sent_at > now() - interval '1 day' $$;

-- Call events from the voice webhooks. event: 'answered' (a person picked up), 'hook' (pressed 1 or said yes, or
-- stayed past the pressure line: a practice opportunity), 'refused' (said no or pressed another key: spotted it),
-- 'revealed' (heard the reveal), 'link' (a coaching link was issued for a text), 'stop' (pressed 9), and the end of
-- the call: 'ended' with the duration, which settles the outcome if nothing else did and returns whether a
-- follow-up reveal is needed.
create function public.record_call_event(pid uuid, event text, call_sid text default null, duration int default null, answered_by text default null) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices; tok text; who text; nm text; scam text; recent int;
begin
 perform safekeep_private.service_only();
 select * into p from public.user_practices where id=pid and channel='phone' for update;
 if not found then return null; end if;
 if event='answered' then
  update public.user_practices set delivery_status='delivered', delivered_at=coalesce(delivered_at,now()) where id=pid and delivery_status='sent';
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(pid,'call_answered',now(),'voice');
 elsif event='hook' then
  if p.result in ('pending','no_observed_engagement') then update public.user_practices set result='engaged', engaged_at=now() where id=pid; end if;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(pid,'keypress',now(),'voice');
 elsif event='refused' then
  if p.result in ('pending','no_observed_engagement') then update public.user_practices set result='declined', completed_at=now() where id=pid; end if;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(pid,'keypress',now(),'voice');
 elsif event='revealed' then
  update public.user_practices set revealed_at=coalesce(revealed_at,now()) where id=pid;
 elsif event='link' then
  return jsonb_build_object('token',safekeep_private.new_link(pid,'call'));
 elsif event='stop' then
  return safekeep_private.stop_practice(p,'voice-9');
 elsif event='ended' then
  if coalesce(answered_by,'human') like 'machine%' or coalesce(answered_by,'')='fax' or duration is null or duration < 5 then
   -- Not answered, voicemail (none is left) or a hang-up inside five seconds: nothing observed.
   update public.user_practices set result='no_observed_engagement', completed_at=now() where id=pid and result='pending';
   if duration is null or coalesce(answered_by,'') like 'machine%' then
    -- Three unanswered practice calls in a row to the same number pause calls to it, like a bounce.
    select count(*) into recent from (select x.result, x.delivered_at from public.user_practices x where x.destination_contact_id=p.destination_contact_id and x.channel='phone' and x.sent_at is not null order by x.sent_at desc limit 3) r
    where r.result='no_observed_engagement' and r.delivered_at is null;
    if recent >= 3 then perform public.mark_practice_failed(pid,'three unanswered calls',true); end if;
   end if;
  elsif p.result='pending' then
   -- Answered and hung up before the hook: spotted it.
   update public.user_practices set result='declined', completed_at=now() where id=pid;
  end if;
  -- Every practice reveals itself: anyone who answered but didn't hear the reveal gets a short email saying so.
  select * into p from public.user_practices where id=pid;
  if p.revealed_at is null and duration is not null and duration >= 5 and coalesce(answered_by,'human') not like 'machine%' then
   tok := safekeep_private.new_link(pid,'reveal');
   select u.email, coalesce(pf.preferred_name,pf.first_name,'there') into who, nm from auth.users u left join public.user_profiles pf on pf.user_id=u.id where u.id=p.user_id;
   select s.name into scam from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.id=p.scam_version_id;
   if who is not null then
    insert into public.outbound_emails(to_email,subject,body,kind) values(who,'That call was a Safekeep practice',
     'Hello '||nm||','||E'\n\n'||'The call you got today was a practice from Safekeep, not a real one. Nothing happened to your money or your information.'||
     case when p.result='declined' then ' You hung up, which was exactly the right thing to do.' else '' end||E'\n\n'||
     'Here are the warning signs it had, and what to do if a real one calls:'||E'\n'||safekeep_private.app_origin()||'/p/'||tok||E'\n\n'||'The Safekeep team','practice_reveal');
    update public.user_practices set revealed_at=now() where id=pid;
   end if;
  end if;
 end if;
 return jsonb_build_object('saved',true);
end $$;

revoke all on function public.practice_for_text_reply(text), public.stop_texts_from(text), public.record_text_reply(uuid,text,text,text), public.call_script(uuid), public.record_call_event(uuid,text,text,int,text) from public, anon, authenticated;
grant execute on function public.practice_for_text_reply(text), public.stop_texts_from(text), public.record_text_reply(uuid,text,text,text), public.call_script(uuid), public.record_call_event(uuid,text,text,int,text) to service_role;

-- The planner now takes the channels that are switched on for sending, so nothing is planned for a channel whose
-- provider isn't set up yet (a planned practice would otherwise wait unsent and hold the participant's one slot).
-- Same rules as before; only the channel filter is new.
drop function public.plan_practices();
-- Planner (service role, hourly): one scheduled practice at a time for each active participant who has practice on,
-- isn't paused, and has at least one channel with a current grant on a verified contact. Honours the weekly cap, the
-- per-channel monthly caps, the hard cap of seven a month across channels, and never two on the same local day.
create function public.plan_practices(channels text[] default array['email']) returns int language plpgsql volatile security definer set search_path = '' as $$
declare p record; ch record; chosen_channel text; chosen_contact uuid; version uuid; tz text; local_today date; month_start timestamptz;
 week_count int; month_total int; ch_count int; ch_cap int; day date; at timestamptz; tries int; planned int := 0; gap_days numeric;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 for p in
  select distinct m.user_id, pr.max_practices_per_week, pr.quiet_hours_start, pr.quiet_hours_end, pr.email_cap_per_month, pr.text_cap_per_month, pr.call_cap_per_month, coalesce(up.timezone,'America/New_York') as timezone
  from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
  join public.user_preferences pr on pr.user_id=m.user_id left join public.user_profiles up on up.user_id=m.user_id
  where m.role='participant' and m.status='active' and public.is_active_participant(m.user_id)
    and pr.practice_enabled and (pr.paused_until is null or pr.paused_until <= current_date) and pr.max_practices_per_week > 0
    and not exists(select 1 from public.user_practices f where f.user_id=m.user_id and f.delivery_status in ('scheduled','queued'))
    and not exists(select 1 from public.account_deletions d where d.user_id=m.user_id and d.cancelled_at is null)
 loop
  tz := p.timezone; local_today := (now() at time zone tz)::date; month_start := (date_trunc('month', now() at time zone tz)) at time zone tz;
  select count(*) into week_count from public.user_practices where user_id=p.user_id and safekeep_private.counted(delivery_status) and coalesce(sent_at,scheduled_at) > now() - interval '7 days';
  if week_count >= p.max_practices_per_week then continue; end if;
  select count(*) into month_total from public.user_practices where user_id=p.user_id and safekeep_private.counted(delivery_status) and coalesce(sent_at,scheduled_at) >= month_start;
  if month_total >= 7 then continue; end if;
  chosen_channel := null; chosen_contact := null;
  for ch in
   select x.channel, (select c.id from public.user_contacts c where c.user_id=p.user_id and c.verified_at is not null and c.suppressed_at is null
                       and ((x.channel='email' and c.kind='email') or (x.channel='text' and c.kind='mobile') or (x.channel='phone' and c.kind<>'email'))
                       and safekeep_private.has_grant(c.id, x.channel) order by c.created_at limit 1) as contact_id
   from (values ('email'),('text'),('phone')) x(channel) where x.channel = any(channels) order by random()
  loop
   continue when ch.contact_id is null;
   ch_cap := case ch.channel when 'email' then p.email_cap_per_month when 'text' then p.text_cap_per_month else p.call_cap_per_month end;
   select count(*) into ch_count from public.user_practices where user_id=p.user_id and channel=ch.channel and safekeep_private.counted(delivery_status) and coalesce(sent_at,scheduled_at) >= month_start;
   continue when ch_count >= ch_cap;
   version := safekeep_private.pick_version(p.user_id, safekeep_private.channel_format(ch.channel));
   continue when version is null;
   chosen_channel := ch.channel; chosen_contact := ch.contact_id; exit;
  end loop;
  continue when chosen_channel is null;
  -- Spread practices across the week: a random day within 7/cap days, never today if one already went today.
  gap_days := 7.0 / p.max_practices_per_week; tries := 0;
  loop
   tries := tries + 1;
   day := local_today + floor(random() * greatest(gap_days,1))::int;
   at := safekeep_private.random_moment(day, tz, p.quiet_hours_start, p.quiet_hours_end);
   if at < now() + interval '15 minutes' then day := day + 1; at := safekeep_private.random_moment(day, tz, p.quiet_hours_start, p.quiet_hours_end); end if;
   exit when not exists(select 1 from public.user_practices o where o.user_id=p.user_id and safekeep_private.counted(o.delivery_status) and (coalesce(o.sent_at,o.scheduled_at) at time zone tz)::date = (at at time zone tz)::date) or tries > 6;
  end loop;
  continue when tries > 6;
  insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,channel,difficulty_at_send)
  select p.user_id, version, chosen_contact, at, chosen_channel, v.difficulty from public.practice_scam_versions v where v.id=version;
  planned := planned + 1;
 end loop;
 return planned;
end $$;
revoke all on function public.plan_practices(text[]) from public, anon, authenticated;
grant execute on function public.plan_practices(text[]) to service_role;
-- Anything already planned for a channel that is switched off is cancelled by the sender each run.
create function public.cancel_planned_outside(channels text[]) returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
 perform safekeep_private.service_only();
 update public.user_practices set delivery_status='cancelled', cancel_reason='channel not sending' where delivery_status='scheduled' and not (channel = any(channels));
 get diagnostics n = row_count; return n;
end $$;
revoke all on function public.cancel_planned_outside(text[]) from public, anon, authenticated;
grant execute on function public.cancel_planned_outside(text[]) to service_role;
