-- Migration: practice_engine
-- Phase 4 of the MVP PRD ("Email practice, end to end") and the parts of "Practice scam engine", "Delivering
-- practice scams" and "Coaching" it needs: library fields, the admin review queue, the planner and the pre-send
-- re-check, tokenized coaching, one-click stop, reporting, observation windows and retirement. Channel-agnostic,
-- so text and phone (phases 6-7) plug into the same functions. Apply after invitations.sql.

-- Library -----------------------------------------------------------------------------------------------------------
alter table public.practice_scam_versions
 add column tells jsonb not null default '[]',            -- [{quote, note}]: each quote appears verbatim in content
 add column channel_variant jsonb not null default '{}',  -- email: {from_name, from_local}; text: {reply_keywords}; phone: {script}
 add column brand_mode text not null default 'generic' check(brand_mode in ('fictional','generic')),
 add column expires_at timestamptz,
 add column source_item_id uuid,
 add column generated_by text not null default 'human' check(generated_by in ('human','model','model_edited')),
 add column approved_by_user_id uuid references auth.users(id) on delete set null,
 add column approved_at timestamptz,
 add column rejected_at timestamptz, add column rejection_note text,
 add column next_steps text[] not null default '{}',     -- two or three moves, in the participant's words
 add column question jsonb,                               -- {prompt, choices[3], correct, affirm, gently}
 add column context_url text;                             -- a Scam Alert or guide on the site
create index practice_scam_versions_pick_idx on public.practice_scam_versions(format,status,difficulty);

-- Deliveries ----------------------------------------------------------------------------------------------------------
alter table public.user_practices
 add column channel text check(channel in ('email','text','phone')),
 add column access_token_hash text unique,
 add column difficulty_at_send int check(difficulty_at_send between 1 and 5),
 add column coaching_answer text check(coaching_answer in ('correct','incorrect','skipped')),
 add column cancel_reason text, add column failure_reason text,
 add column shares int not null default 0,
 add column retries int not null default 0,
 add column claimed_at timestamptz;
-- A family member's copy of a coaching page has its own token, so it can't stop practice, answer the question or count
-- as a click on the participant's behalf.
create table public.practice_shares (
 id uuid primary key default gen_random_uuid(),
 user_practice_id uuid not null references public.user_practices(id) on delete cascade,
 token_hash text not null unique, to_email text not null, created_at timestamptz not null default now(), viewed_at timestamptz
);
alter table public.practice_shares enable row level security;
revoke all on public.practice_shares from public, anon, authenticated;
grant all on public.practice_shares to service_role;
alter table public.practice_events drop constraint practice_events_event_type_check;
alter table public.practice_events add constraint practice_events_event_type_check check(event_type in
 ('queued','sent','delivered','failed','link_clicked','replied','call_answered','reported','debrief_completed','keypress','coaching_viewed','coaching_shared','distress_flagged','stop_received'));
alter table public.outbound_emails drop constraint outbound_emails_kind_check;
alter table public.outbound_emails add constraint outbound_emails_kind_check check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed','invitation','invitation_accepted','invitation_declined','invitation_expired','invitation_reminder','practice_paused','coaching_share'));

-- Admins --------------------------------------------------------------------------------------------------------------
create table public.admin_users (user_id uuid primary key references auth.users(id) on delete cascade, granted_at timestamptz not null default now(), granted_by uuid);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from public, anon, authenticated;
grant all on public.admin_users to service_role;
create function safekeep_private.is_admin(who uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.admin_users where user_id=who) $$;

-- Helpers -------------------------------------------------------------------------------------------------------------
-- The latest grant for a channel on a contact, or null.
create function safekeep_private.has_grant(cid uuid, ch text) returns boolean language sql stable security definer set search_path = '' as $$
 select coalesce((select e.action='grant' from public.consent_events e where e.contact_id=cid and e.channel=ch order by e.sequence desc limit 1),false) $$;
-- A practice counts against caps once it is planned, unless it was cancelled or failed.
create function safekeep_private.in_quiet_hours(at timestamptz, tz text, quiet_start time, quiet_end time) returns boolean language sql stable set search_path = '' as $$
 select case when quiet_start > quiet_end then (at at time zone tz)::time >= quiet_start or (at at time zone tz)::time < quiet_end
             else (at at time zone tz)::time >= quiet_start and (at at time zone tz)::time < quiet_end end $$;
create function safekeep_private.counted(status text) returns boolean language sql immutable as $$ select status in ('scheduled','queued','sent','delivered') $$;
create function safekeep_private.channel_format(ch text) returns text language sql immutable as $$ select case ch when 'email' then 'email' when 'text' then 'text' when 'phone' then 'phone' end $$;

-- Selection per participant (PRD "Selection per participant"): a published version for the format, not a scam they
-- have seen in 180 days, difficulty stepped from their recent results, weak categories weighted up, and the first
-- three practices kept at difficulty 1-2.
create function safekeep_private.pick_version(uid uuid, fmt text) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare n int; last_diff int; r1 text; r2 text; target int; chosen uuid;
begin
 select count(*) into n from public.user_practices where user_id=uid and delivery_status in ('sent','delivered');
 select difficulty_at_send, result into last_diff, r1 from public.user_practices where user_id=uid and delivery_status in ('sent','delivered') and result<>'pending' order by sent_at desc limit 1;
 select result into r2 from public.user_practices where user_id=uid and delivery_status in ('sent','delivered') and result<>'pending' order by sent_at desc offset 1 limit 1;
 if n < 3 or last_diff is null then target := 1 + (n % 2);
 elsif r1='engaged' then target := greatest(1,last_diff-1);
 elsif r1 in ('reported','declined') and r2 in ('reported','declined') then target := least(5,last_diff+1);
 else target := last_diff; end if;
 select v.id into chosen from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id
 where v.format=fmt and v.status='published' and s.archived_at is null and (v.expires_at is null or v.expires_at > now() + interval '3 days')
   and (n >= 3 or v.difficulty <= 2)
   and not exists(select 1 from public.user_practices p join public.practice_scam_versions pv on pv.id=p.scam_version_id
                  where p.user_id=uid and pv.scam_id=v.scam_id and p.created_at > now() - interval '180 days' and p.delivery_status not in ('cancelled','failed'))
 order by abs(v.difficulty-target)
   - case when exists(select 1 from public.user_practices p join public.practice_scam_versions pv on pv.id=p.scam_version_id join public.practice_scams ps on ps.id=pv.scam_id
                      where p.user_id=uid and p.result='engaged' and ps.category=s.category and p.engaged_at > now() - interval '90 days') then 0.5 else 0 end
   + random()*0.99
 limit 1;
 return chosen;
end $$;

-- A random moment on a local date, inside the participant's allowed window (outside quiet hours), as timestamptz.
create function safekeep_private.random_moment(day date, tz text, quiet_start time, quiet_end time) returns timestamptz language plpgsql volatile set search_path = '' as $$
declare span interval; start_t interval := quiet_end::interval; offset_i interval;
begin
 span := case when quiet_start > quiet_end then quiet_start - quiet_end else (quiet_start::interval + interval '24 hours') - quiet_end::interval end;
 if span <= interval '0' then span := interval '1 hour'; end if;
 -- Keep a ten-minute margin inside each edge of the window.
 offset_i := interval '10 minutes' + (random() * greatest(extract(epoch from span) - 1200, 60)) * interval '1 second';
 return ((day::timestamp + start_t + offset_i) at time zone tz);
end $$;

-- Planner (service role, hourly): one scheduled practice at a time for each active participant who has practice on,
-- isn't paused, and has at least one channel with a current grant on a verified contact. Honours the weekly cap, the
-- per-channel monthly caps, the hard cap of seven a month across channels, and never two on the same local day.
create function public.plan_practices() returns int language plpgsql volatile security definer set search_path = '' as $$
declare p record; ch record; chosen_channel text; chosen_contact uuid; version uuid; tz text; local_today date; month_start timestamptz;
 week_count int; month_total int; ch_count int; ch_cap int; day date; at timestamptz; tries int; planned int := 0; gap_days numeric;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 for p in
  select distinct m.user_id, pr.max_practices_per_week, pr.quiet_hours_start, pr.quiet_hours_end, pr.email_cap_per_month, pr.text_cap_per_month, pr.call_cap_per_month, coalesce(up.timezone,'America/New_York') as timezone
  from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id
  join public.user_preferences pr on pr.user_id=m.user_id left join public.user_profiles up on up.user_id=m.user_id
  where m.role='participant' and m.status='active' and public.is_active_participant(m.user_id)
    and pr.practice_enabled and (pr.paused_until is null or pr.paused_until <= (now() at time zone coalesce(up.timezone,'America/New_York'))::date) and pr.max_practices_per_week > 0
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
   from (values ('email'),('text'),('phone')) x(channel) order by random()
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

-- The pre-send check (PRD: "the single most important line of code in the system"), in one query: the plan is active,
-- the participant has practice on and isn't paused or deleting, the contact is verified and not suppressed, the latest
-- consent event for this contact and channel is a grant, the version is still published, and the caps still hold.
create function safekeep_private.send_blocker(pid uuid) returns text language sql stable security definer set search_path = '' as $$
 select case
  when not public.is_active_participant(p.user_id) then 'no active plan'
  when not coalesce(pr.practice_enabled,false) then 'practice off'
  when pr.paused_until is not null and pr.paused_until > (now() at time zone coalesce(up.timezone,'America/New_York'))::date then 'paused'
  when exists(select 1 from public.account_deletions d where d.user_id=p.user_id and d.cancelled_at is null) then 'deletion pending'
  when c.verified_at is null or c.suppressed_at is not null then 'contact not usable'
  when not safekeep_private.has_grant(c.id, p.channel) then 'no consent'
  when v.status<>'published' then 'version not published'
  when (select count(*) from public.user_practices o where o.user_id=p.user_id and o.id<>p.id and o.delivery_status in ('sent','delivered')
        and o.sent_at >= (date_trunc('month', now() at time zone coalesce(up.timezone,'America/New_York'))) at time zone coalesce(up.timezone,'America/New_York')) >= 7 then 'monthly cap'
  when exists(select 1 from public.user_practices o where o.user_id=p.user_id and o.id<>p.id and o.delivery_status in ('sent','delivered')
        and (o.sent_at at time zone coalesce(up.timezone,'America/New_York'))::date = (now() at time zone coalesce(up.timezone,'America/New_York'))::date) then 'already one today'
  else null end
 from public.user_practices p join public.user_contacts c on c.id=p.destination_contact_id join public.practice_scam_versions v on v.id=p.scam_version_id
 left join public.user_preferences pr on pr.user_id=p.user_id left join public.user_profiles up on up.user_id=p.user_id
 where p.id=pid $$;

-- Claim due practices for one channel (service role). Rows that fail the check are cancelled with the reason; rows
-- that pass are marked queued with a fresh single-use token whose hash is stored. Returns what the sender needs.
create function public.claim_due_practices(ch text, lim int default 25) returns table(practice_id uuid, address text, extension text, token text, difficulty int, subject text, content text, channel_variant jsonb, idempotency_key uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare r record; blocker text; tok text; day date;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 -- A send interrupted after claiming (a timeout or crash) leaves a row queued. It may or may not have gone out, so it
 -- is closed as failed rather than sent again, which also frees the participant's slot for the next plan.
 update public.user_practices set delivery_status='failed', failure_reason='send interrupted' where channel=ch and delivery_status='queued' and claimed_at < now() - interval '30 minutes';
 for r in select p.id, coalesce(up.timezone,'America/New_York') tz, coalesce(pr.quiet_hours_start,'20:00') qs, coalesce(pr.quiet_hours_end,'09:00') qe
  from public.user_practices p left join public.user_profiles up on up.user_id=p.user_id left join public.user_preferences pr on pr.user_id=p.user_id
  where p.channel=ch and p.delivery_status='scheduled' and p.scheduled_at <= now() order by p.scheduled_at limit lim for update of p skip locked loop
  -- A late run, a retry or changed quiet hours can land inside quiet hours: move it to the next allowed window instead.
  if safekeep_private.in_quiet_hours(now(), r.tz, r.qs, r.qe) then
   day := (now() at time zone r.tz)::date;
   if (now() at time zone r.tz)::time >= r.qe then day := day + 1; end if;
   update public.user_practices set scheduled_at=safekeep_private.random_moment(day, r.tz, r.qs, r.qe) where id=r.id;
   continue;
  end if;
  blocker := safekeep_private.send_blocker(r.id);
  if blocker is not null then
   update public.user_practices set delivery_status='cancelled', cancel_reason=blocker where id=r.id;
   continue;
  end if;
  tok := encode(extensions.gen_random_bytes(24),'hex');
  update public.user_practices set delivery_status='queued', claimed_at=now(), access_token_hash=encode(extensions.digest(tok,'sha256'),'hex') where id=r.id;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(r.id,'queued',now(),'scheduler');
  return query select p.id, c.normalized_value, c.extension, tok, v.difficulty, v.subject, v.content, v.channel_variant, p.idempotency_key
   from public.user_practices p join public.user_contacts c on c.id=p.destination_contact_id join public.practice_scam_versions v on v.id=p.scam_version_id where p.id=r.id;
 end loop;
end $$;

create function public.mark_practice_sent(pid uuid, provider_id text) returns void language sql volatile security definer set search_path = '' as $$
 update public.user_practices set delivery_status='sent', sent_at=now(), observation_ends_at=now()+interval '72 hours', provider_message_id=coalesce(provider_id,provider_message_id) where id=pid and delivery_status='queued';
 insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) select pid,'sent',now(),'sender' where exists(select 1 from public.user_practices where id=pid and delivery_status='sent');
$$;
create function public.mark_practice_delivered(pid uuid, provider_event text) returns void language sql volatile security definer set search_path = '' as $$
 update public.user_practices set delivery_status='delivered', delivered_at=coalesce(delivered_at,now()) where id=pid and delivery_status='sent';
 insert into public.practice_events(user_practice_id,event_type,occurred_at,provider_event_id,evidence_source) values(pid,'delivered',now(),provider_event,'provider') on conflict(provider_event_id) do nothing;
$$;
-- A failed send. A permanent failure (a bounce, an unreachable number) suppresses the contact and tells the
-- participant, and the sponsor of a gifted seat, that practice on that channel has paused until it is updated.
create function public.mark_practice_failed(pid uuid, reason text, permanent boolean default false) returns void language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices; who text; sponsor_email text; nm text; chan text;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 -- A temporary failure is retried once, half an hour later, with a fresh token; never more than once.
 if not permanent then
  update public.user_practices set delivery_status='scheduled', scheduled_at=now()+interval '30 minutes', retries=retries+1, access_token_hash=null, failure_reason=left(reason,200)
  where id=pid and delivery_status='queued' and retries=0 returning * into p;
  if found then insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(pid,'failed',now(),'sender'); return; end if;
 end if;
 update public.user_practices set delivery_status='failed', failure_reason=left(reason,200) where id=pid and delivery_status in ('queued','sent','delivered') returning * into p;
 if not found then return; end if;
 insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(pid,'failed',now(),'provider');
 if not permanent then return; end if;
 update public.user_contacts set suppressed_at=now(), suppression_reason='bounced' where id=p.destination_contact_id and suppressed_at is null;
 update public.user_practices set delivery_status='cancelled', cancel_reason='contact suppressed' where destination_contact_id=p.destination_contact_id and delivery_status in ('scheduled','queued');
 chan := case p.channel when 'email' then 'email' when 'text' then 'text messages' else 'phone calls' end;
 select u.email into who from auth.users u where u.id=p.user_id;
 select coalesce(pf.preferred_name,pf.first_name,'there') into nm from public.user_profiles pf where pf.user_id=p.user_id;
 if who is not null then
  insert into public.outbound_emails(to_email,subject,body,kind) values(who,'Safekeep practice by '||chan||' has paused',
   'Hello '||coalesce(nm,'there')||','||E'\n\n'||'We couldn''t reach you by '||chan||' just now, so practice on that channel has paused. Nothing else changes. To start it again, check the details under Your contacts on your account page: '||safekeep_private.app_origin()||'/account/'||E'\n\n'||'The Safekeep team','practice_paused');
 end if;
 select u.email into sponsor_email from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id join auth.users u on u.id=s.sponsor_user_id
 where m.user_id=p.user_id and m.role='participant' and m.status in ('active','paused') and s.sponsor_user_id<>p.user_id limit 1;
 if sponsor_email is not null then
  insert into public.outbound_emails(to_email,subject,body,kind) values(sponsor_email,coalesce(nm,'Someone on your plan')||'''s practice by '||chan||' has paused',
   'Hello,'||E'\n\n'||'We couldn''t reach '||coalesce(nm,'someone on your plan')||' by '||chan||', so practice on that channel has paused until they update their details. We''ve let them know. Other channels they chose carry on as before.'||E'\n\n'||'The Safekeep team','practice_paused');
 end if;
end $$;

-- Observation windows and retirement (service role, hourly). Nothing within 72 hours of a send counts as ignoring it;
-- versions retire when they expire or when almost nobody is fooled by them (under 5% engaged across 20 or more sends).
create function public.close_observations() returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare closed int; retired_expired int; retired_easy int;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 update public.user_practices set result='no_observed_engagement', completed_at=now() where delivery_status in ('sent','delivered') and result='pending' and observation_ends_at < now();
 get diagnostics closed = row_count;
 update public.practice_scam_versions set status='retired' where status='published' and expires_at is not null and expires_at < now();
 get diagnostics retired_expired = row_count;
 update public.practice_scam_versions v set status='retired' where v.status='published' and v.id in (
  select p.scam_version_id from public.user_practices p where p.delivery_status in ('sent','delivered') and p.result<>'pending'
  group by p.scam_version_id having count(*) >= 20 and (count(*) filter (where p.result='engaged'))::numeric / count(*) < 0.05);
 get diagnostics retired_easy = row_count;
 return jsonb_build_object('closed',closed,'retired_expired',retired_expired,'retired_easy',retired_easy);
end $$;

-- Coaching (the token authenticates; no login). ---------------------------------------------------------------------
create function safekeep_private.practice_by_token(token text) returns public.user_practices language sql stable security definer set search_path = '' as $$
 select * from public.user_practices where access_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and sent_at is not null and sent_at > now() - interval '30 days' $$;

-- What the coaching page shows. The family view (shared) leaves out the outcome and anything that identifies the row.
create function safekeep_private.coaching_payload(p public.user_practices, shared boolean) returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'practice_id', case when shared then null else p.id end, 'shared', shared, 'channel', p.channel, 'format', v.format, 'difficulty', v.difficulty, 'category', s.category, 'name', s.name,
  'subject', v.subject, 'from_name', v.channel_variant->>'from_name', 'content', v.content, 'tells', v.tells, 'debrief', v.debrief,
  'next_steps', to_jsonb(v.next_steps), 'context_url', v.context_url, 'sent_at', p.sent_at,
  'result', case when shared then null else p.result end,
  'question', case when v.question is null or shared then null else jsonb_build_object('prompt', v.question->>'prompt', 'choices', v.question->'choices') end,
  'answered', case when shared then null else p.coaching_answer end,
  'answer', case when not shared and p.coaching_answer in ('correct','incorrect') then jsonb_build_object('correct_index',(v.question->>'correct')::int,'message',case when p.coaching_answer='correct' then v.question->>'affirm' else v.question->>'gently' end) else null end,
  'can_share', not shared and p.shares < 3)
 from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.id=p.scam_version_id $$;

-- Opening the coaching page. With the participant's token, the first open records link_clicked and marks the result
-- "engaged" (a practice opportunity) unless they had already reported it, and every open records coaching_viewed.
-- With a family member's share token it shows the shared view and records nothing about the participant.
create function public.coaching_view(token text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices; sh public.practice_shares;
begin
 p := safekeep_private.practice_by_token(token);
 if p.id is null then
  select * into sh from public.practice_shares where token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and created_at > now() - interval '90 days';
  if not found then return null; end if;
  update public.practice_shares set viewed_at=coalesce(viewed_at,now()) where id=sh.id;
  select * into p from public.user_practices where id=sh.user_practice_id;
  return safekeep_private.coaching_payload(p, true);
 end if;
 if not exists(select 1 from public.practice_events where user_practice_id=p.id and event_type='link_clicked') then
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'link_clicked',now(),'coaching-link');
  if p.result in ('pending','no_observed_engagement') then
   update public.user_practices set result='engaged', engaged_at=now() where id=p.id returning * into p;
  end if;
 end if;
 insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'coaching_viewed',now(),'coaching-page');
 return safekeep_private.coaching_payload(p, false);
end $$;

-- The one question. The first answer is the one recorded; right or wrong, it counts as completed.
create function safekeep_private.answer_question(p public.user_practices, choice int, source text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare q jsonb; correct boolean;
begin
 select v.question into q from public.practice_scam_versions v where v.id=p.scam_version_id;
 if q is null then return null; end if;
 correct := choice = (q->>'correct')::int;
 if p.coaching_answer is null or p.coaching_answer='skipped' then
  update public.user_practices set coaching_answer=case when choice is null then 'skipped' when correct then 'correct' else 'incorrect' end, completed_at=coalesce(completed_at,now()) where id=p.id;
  if choice is not null then insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'debrief_completed',now(),source); end if;
 end if;
 if choice is null then return jsonb_build_object('skipped',true); end if;
 return jsonb_build_object('correct', correct, 'correct_index', (q->>'correct')::int, 'message', case when correct then q->>'affirm' else q->>'gently' end);
end $$;
create function public.coaching_answer(token text, choice int) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices;
begin
 p := safekeep_private.practice_by_token(token);
 if p.id is null then return null; end if;
 if choice is not null and (choice < 0 or choice > 2) then raise exception 'Choose one of the three answers'; end if;
 return safekeep_private.answer_question(p, choice, 'coaching-page');
end $$;

-- Share the coaching page with a family member: up to three per practice, each with its own token.
create function safekeep_private.share_practice(p public.user_practices, to_email text, to_name text, from_name text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare nm text; who text; tok text;
begin
 if p.shares >= 3 then raise exception 'You''ve shared this one three times already'; end if;
 to_email := lower(trim(coalesce(to_email,'')));
 if to_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(to_email)>254 then raise exception 'Enter their email address'; end if;
 select coalesce(nullif(trim(from_name),''),pf.preferred_name,pf.first_name) into nm from public.user_profiles pf where pf.user_id=p.user_id;
 nm := left(coalesce(nm, nullif(trim(from_name),''), 'Someone in your family'),80);
 who := coalesce(nullif(left(trim(to_name),80),''),'there');
 tok := encode(extensions.gen_random_bytes(24),'hex');
 insert into public.practice_shares(user_practice_id,token_hash,to_email) values(p.id,encode(extensions.digest(tok,'sha256'),'hex'),to_email);
 update public.user_practices set shares=shares+1 where id=p.id;
 insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'coaching_shared',now(),'coaching-page');
 insert into public.outbound_emails(to_email,subject,body,kind) values(to_email, nm||' wanted to show you a scam to watch for',
  'Hello '||who||','||E'\n\n'||nm||' practises spotting scams with Safekeep and wanted to show you one they came across, with the warning signs marked:'||E'\n'||safekeep_private.app_origin()||'/p/'||tok||E'\n\n'||'It was a practice message, so nothing happened to anyone''s money or information. It''s worth a look, because the real ones work the same way.'||E'\n\n'||'The Safekeep team','coaching_share');
 return jsonb_build_object('saved',true,'shares_left',2-p.shares);
end $$;
create function public.coaching_share(token text, to_email text, to_name text, from_name text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices;
begin
 p := safekeep_private.practice_by_token(token);
 if p.id is null then return jsonb_build_object('saved',false); end if;
 return safekeep_private.share_practice(p, to_email, to_name, from_name);
end $$;

-- One-click stop from any practice message (the email's unsubscribe link and header, later STOP by text and 9 on a
-- call): consent for that contact and channel is withdrawn and anything planned for it is cancelled. Works for as
-- long as the message exists, not just 30 days.
-- The footer's stop link opens a page that only asks to confirm. It must not count as opening the practice, and it has
-- to work for as long as the message exists, so it looks the token up without the 30-day limit and records nothing.
create function public.stop_info(token text) returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('channel',p.channel,'active',safekeep_private.has_grant(p.destination_contact_id,p.channel))
 from public.user_practices p where p.access_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and p.sent_at is not null $$;
revoke all on function public.stop_info(text) from public;
grant execute on function public.stop_info(text) to anon, authenticated;

create function safekeep_private.stop_practice(p public.user_practices, source text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
 if safekeep_private.has_grant(p.destination_contact_id, p.channel) then
  insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values(p.user_id,p.destination_contact_id,p.channel,'revoke','practice-stop',source);
 end if;
 update public.user_practices set delivery_status='cancelled', cancel_reason='stopped by participant' where user_id=p.user_id and destination_contact_id=p.destination_contact_id and channel=p.channel and delivery_status in ('scheduled','queued');
 insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'stop_received',now(),source);
 return jsonb_build_object('saved',true,'channel',p.channel);
end $$;
create function public.stop_by_token(token text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices;
begin
 select * into p from public.user_practices where access_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and sent_at is not null;
 if not found then return jsonb_build_object('saved',false); end if;
 return safekeep_private.stop_practice(p, 'practice-'||p.channel);
end $$;
-- The same, from a provider webhook (a spam complaint now, STOP by text later). Service role only.
create function public.stop_by_practice(pid uuid, source text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.user_practices;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 select * into p from public.user_practices where id=pid;
 if not found then return jsonb_build_object('saved',false); end if;
 return safekeep_private.stop_practice(p, left(source,40));
end $$;
revoke all on function public.stop_by_practice(uuid,text) from public, anon, authenticated;
grant execute on function public.stop_by_practice(uuid,text) to service_role;

revoke all on function public.coaching_view(text), public.coaching_answer(text,int), public.coaching_share(text,text,text,text), public.stop_by_token(text) from public;
grant execute on function public.coaching_view(text), public.coaching_answer(text,int), public.coaching_share(text,text,text,text), public.stop_by_token(text) to anon, authenticated;
revoke all on function public.plan_practices(), public.claim_due_practices(text,int), public.mark_practice_sent(uuid,text), public.mark_practice_delivered(uuid,text), public.mark_practice_failed(uuid,text,boolean), public.close_observations() from public, anon, authenticated;
grant execute on function public.plan_practices(), public.claim_due_practices(text,int), public.mark_practice_sent(uuid,text), public.mark_practice_delivered(uuid,text), public.mark_practice_failed(uuid,text,boolean), public.close_observations() to service_role;

-- The participant's side, signed in. ----------------------------------------------------------------------------------
-- History lists a practice once its outcome is known, so the list can't be used to check a message that is still
-- in its observation window. That is what "Was this Safekeep?" is for.
create function public.my_practice_history() returns table(practice_id uuid, sent_at timestamptz, channel text, category text, name text, result text, coached boolean)
language sql stable security definer set search_path = '' as $$
 select p.id, p.sent_at, p.channel, s.category, s.name, p.result, p.coaching_answer in ('correct','incorrect')
 from public.user_practices p join public.practice_scam_versions v on v.id=p.scam_version_id join public.practice_scams s on s.id=v.scam_id
 where p.user_id=auth.uid() and p.delivery_status in ('sent','delivered') and p.result<>'pending' order by p.sent_at desc limit 60 $$;

create function safekeep_private.practice_action(action text, payload jsonb default '{}') returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p public.user_practices; ch text; since timestamptz; tz text;
begin
 if uid is null then raise exception 'Sign in first' using errcode='42501'; end if;
 if action='was_this_safekeep' then
  -- The participant describes a message they're unsure about: which channel, and roughly when. If Safekeep sent one
  -- then, it's shown so they can compare it with what they got; nothing is recorded until they confirm it's the one
  -- (confirm_report), so a real scam that arrived the same week is never mistaken for ours.
  ch := payload->>'channel';
  if ch not in ('email','text','phone') then raise exception 'Choose email, text or phone call'; end if;
  select coalesce(timezone,'America/New_York') into tz from public.user_profiles where user_id=uid;
  tz := coalesce(tz,'America/New_York');
  since := case payload->>'when' when 'today' then (date_trunc('day', now() at time zone tz)) at time zone tz
                                 when 'yesterday' then (date_trunc('day', now() at time zone tz) - interval '1 day') at time zone tz
                                 else now() - interval '14 days' end;
  select * into p from public.user_practices where user_id=uid and channel=ch and delivery_status in ('sent','delivered') and sent_at >= since
   and (payload->>'when' is distinct from 'yesterday' or sent_at < (date_trunc('day', now() at time zone tz)) at time zone tz)
   order by (result in ('pending','no_observed_engagement')) desc, sent_at desc limit 1;
  if not found then return jsonb_build_object('ours',false); end if;
  return jsonb_build_object('ours',true,'practice_id',p.id,'coaching',safekeep_private.coaching_payload(p, false));
 end if;
 if action='confirm_report' then
  -- "Yes, that's the one": spotting it is the best outcome. Reporting after clicking still counts the click.
  select * into p from public.user_practices where id=(payload->>'practice_id')::uuid and user_id=uid and delivery_status in ('sent','delivered') and sent_at > now() - interval '14 days';
  if not found then raise exception 'Practice not found' using errcode='42501'; end if;
  if p.result in ('pending','no_observed_engagement') then
   update public.user_practices set result='reported', completed_at=coalesce(completed_at,now()) where id=p.id returning * into p;
  end if;
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'reported',now(),'account');
  return jsonb_build_object('coaching',safekeep_private.coaching_payload(p, false));
 end if;
 select * into p from public.user_practices where id=(payload->>'practice_id')::uuid and user_id=uid and delivery_status in ('sent','delivered') and result<>'pending';
 if not found then raise exception 'Practice not found' using errcode='42501'; end if;
 if action='view' then
  insert into public.practice_events(user_practice_id,event_type,occurred_at,evidence_source) values(p.id,'coaching_viewed',now(),'account');
  return safekeep_private.coaching_payload(p, false);
 elsif action='answer' then
  return safekeep_private.answer_question(p, (payload->>'choice')::int, 'account');
 elsif action='share' then
  return safekeep_private.share_practice(p, payload->>'to_email', payload->>'to_name', payload->>'from_name');
 else raise exception 'Unknown practice action';
 end if;
end $$;
revoke all on function safekeep_private.practice_action(text,jsonb) from public,anon;
grant execute on function safekeep_private.practice_action(text,jsonb) to authenticated;
create function public.practice_action(action text, payload jsonb default '{}') returns jsonb language sql security invoker set search_path = '' as $$ select safekeep_private.practice_action(action,payload); $$;
revoke all on function public.practice_action(text,jsonb), public.my_practice_history() from public,anon;
grant execute on function public.practice_action(text,jsonb), public.my_practice_history() to authenticated;

-- Admin: the review queue (nothing reaches published without a click), deliveries, and suppression. ---------------------
create function safekeep_private.admin_action(action text, payload jsonb default '{}') returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ver public.practice_scam_versions; nv uuid;
begin
 if uid is null or not safekeep_private.is_admin(uid) then raise exception 'Admins only' using errcode='42501'; end if;
 if action='queue' then
  return coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'scam',s.name,'code',s.stable_code,'category',s.category,'format',v.format,'difficulty',v.difficulty,'subject',v.subject,'content',v.content,
   'tells',v.tells,'debrief',v.debrief,'next_steps',v.next_steps,'question',v.question,'channel_variant',v.channel_variant,'version',v.version_number,'generated_by',v.generated_by,'created_at',v.created_at) order by v.created_at)
   from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.status='draft' and v.rejected_at is null),'[]');
 elsif action='library' then
  return coalesce((select jsonb_agg(jsonb_build_object('format',format,'status',status,'count',n)) from (select format,status,count(*) n from public.practice_scam_versions group by 1,2) x),'[]');
 elsif action='deliveries' then
  return coalesce((select jsonb_agg(row_to_json(d)) from (select p.id, u.email, p.channel, s.name, p.delivery_status, p.result, p.scheduled_at, p.sent_at, p.cancel_reason, p.failure_reason, p.destination_contact_id as contact_id
   from public.user_practices p join auth.users u on u.id=p.user_id join public.practice_scam_versions v on v.id=p.scam_version_id join public.practice_scams s on s.id=v.scam_id
   order by coalesce(p.sent_at,p.scheduled_at) desc limit 100) d),'[]');
 elsif action='approve' then
  update public.practice_scam_versions set status='published', approved_by_user_id=uid, approved_at=now() where id=(payload->>'version_id')::uuid and status='draft' returning * into ver;
  if not found then raise exception 'Draft not found'; end if;
  -- One published version per scam and format: approving a new one retires the old, history kept.
  update public.practice_scam_versions set status='retired' where scam_id=ver.scam_id and format=ver.format and status='published' and id<>ver.id;
 elsif action='reject' then
  update public.practice_scam_versions set rejected_at=now(), rejection_note=left(payload->>'note',500), status='retired' where id=(payload->>'version_id')::uuid and status='draft';
  if not found then raise exception 'Draft not found'; end if;
 elsif action='edit' then
  -- Editing makes a new draft version; the edited one is rejected with a pointer, so history is preserved.
  select * into ver from public.practice_scam_versions where id=(payload->>'version_id')::uuid;
  if not found then raise exception 'Version not found'; end if;
  insert into public.practice_scam_versions(scam_id,version_number,format,language,difficulty,subject,content,learning_objective,warning_signs,debrief,status,tells,channel_variant,brand_mode,expires_at,source_item_id,generated_by,next_steps,question,context_url)
  values(ver.scam_id,(select max(version_number)+1 from public.practice_scam_versions where scam_id=ver.scam_id),ver.format,ver.language,
   coalesce((payload->>'difficulty')::int,ver.difficulty),coalesce(payload->>'subject',ver.subject),coalesce(payload->>'content',ver.content),ver.learning_objective,ver.warning_signs,coalesce(payload->>'debrief',ver.debrief),'draft',
   coalesce(payload->'tells',ver.tells),coalesce(payload->'channel_variant',ver.channel_variant),ver.brand_mode,ver.expires_at,ver.source_item_id,case when ver.generated_by='human' then 'human' else 'model_edited' end,
   coalesce((select array_agg(x) from jsonb_array_elements_text(payload->'next_steps') x),ver.next_steps),coalesce(payload->'question',ver.question),coalesce(payload->>'context_url',ver.context_url))
  returning id into nv;
  if ver.status='draft' then update public.practice_scam_versions set rejected_at=now(), rejection_note='edited into a new version', status='retired' where id=ver.id; end if;
  return jsonb_build_object('saved',true,'version_id',nv);
 elsif action='suppress_contact' then
  update public.user_contacts set suppressed_at=now(), suppression_reason='admin' where id=(payload->>'contact_id')::uuid;
  update public.user_practices set delivery_status='cancelled', cancel_reason='contact suppressed' where destination_contact_id=(payload->>'contact_id')::uuid and delivery_status in ('scheduled','queued');
 else raise exception 'Unknown admin action';
 end if;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function safekeep_private.admin_action(text,jsonb) from public,anon;
grant execute on function safekeep_private.admin_action(text,jsonb) to authenticated;
create function public.admin_action(action text, payload jsonb default '{}') returns jsonb language sql security invoker set search_path = '' as $$ select safekeep_private.admin_action(action,payload); $$;
revoke all on function public.admin_action(text,jsonb) from public,anon;
grant execute on function public.admin_action(text,jsonb) to authenticated;
create function public.am_i_admin() returns boolean language sql stable security definer set search_path = '' as $$ select safekeep_private.is_admin(auth.uid()) $$;
grant execute on function public.am_i_admin() to authenticated;

-- The private helpers run inside the functions above; nobody calls them directly.
revoke all on function safekeep_private.is_admin(uuid), safekeep_private.has_grant(uuid,text), safekeep_private.in_quiet_hours(timestamptz,text,time,time), safekeep_private.counted(text), safekeep_private.channel_format(text),
 safekeep_private.pick_version(uuid,text), safekeep_private.random_moment(date,text,time,time), safekeep_private.send_blocker(uuid), safekeep_private.practice_by_token(text), safekeep_private.coaching_payload(public.user_practices,boolean),
 safekeep_private.answer_question(public.user_practices,int,text), safekeep_private.share_practice(public.user_practices,text,text,text), safekeep_private.stop_practice(public.user_practices,text) from public, anon, authenticated;
