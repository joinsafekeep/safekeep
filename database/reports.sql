-- Migration: monthly_reports
-- Phase 8 of the MVP PRD ("Monthly report"): one SQL function computes every number, so the emails, the account page
-- and the admin view agree; the reports themselves; the family web view by token; per-recipient unsubscribe; and the
-- founders' metrics. Apply after practice-channels.sql.

alter table public.outbound_emails add column html text;
alter table public.outbound_emails drop constraint outbound_emails_kind_check;
alter table public.outbound_emails add constraint outbound_emails_kind_check check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed','invitation','invitation_accepted','invitation_declined','invitation_expired','invitation_reminder','practice_paused','coaching_share','alerts_confirm','distress_alert','practice_reveal','report_participant','report_family','report_sponsor'));

create table public.monthly_reports (
 id uuid primary key default gen_random_uuid(),
 participant_user_id uuid not null references auth.users(id) on delete cascade,
 month date not null check(extract(day from month)=1),
 kind text not null default 'monthly' check(kind in ('monthly','welcome')),
 metrics jsonb not null, generated_at timestamptz not null default now(),
 sent_to_participant_at timestamptz, sent_to_family_at timestamptz,
 web_token_hash text unique,
 unique(participant_user_id, month, kind)
);
alter table public.monthly_reports enable row level security;
revoke all on public.monthly_reports from public, anon, authenticated;
grant all on public.monthly_reports to service_role;

-- Sponsors on Pairs and Family plans get one email covering each participant who chose them as a reader. Each
-- participant's block waits here until the others' reports for that month are likely done (they're generated at
-- 09:00 in each participant's own time zone), then the sender combines them.
create table public.report_rollups (
 id uuid primary key default gen_random_uuid(),
 to_email text not null, month date not null, participant_name text not null, recipient_id uuid not null, sig text not null,
 block_html text not null, block_text text not null, created_at timestamptz not null default now(), sent_at timestamptz
);
alter table public.report_rollups enable row level security;
revoke all on public.report_rollups from public, anon, authenticated;
grant all on public.report_rollups to service_role;

-- Every number in a report (PRD: "What is measured"), for one participant and a time range.
--  received       practices sent or delivered in the range, by channel
--  spotted        reported or declined
--  ignored        no observed engagement
--  opportunities  engaged (clicked, replied, took the hook), each with its category (and, for the participant only,
--                 its name and id so the coaching can be reopened)
--  coached        practices in the range with a completed debrief
--  inconclusive   distress or other unclear endings (shown to nobody as a score)
--  weak_spots     categories with an engaged result in the 90 days before the range ends
--  streak_months  consecutive months up to this one with nothing engaged
--  last_month     the same counts for the month before, for the trend sentence
create function safekeep_private.practice_metrics(uid uuid, range_start timestamptz, range_end timestamptz) returns jsonb language sql stable security definer set search_path = '' as $$
 with p as (
  select up.id, up.channel, up.result, up.coaching_answer, s.category, s.name, up.sent_at
  from public.user_practices up join public.practice_scam_versions v on v.id=up.scam_version_id join public.practice_scams s on s.id=v.scam_id
  where up.user_id=uid and up.delivery_status in ('sent','delivered','failed') and up.sent_at >= range_start and up.sent_at < range_end
   and up.delivery_status<>'failed'
 ), prev as (
  select up.result from public.user_practices up where up.user_id=uid and up.delivery_status in ('sent','delivered') and up.sent_at >= range_start - interval '1 month' and up.sent_at < range_start
 ), months as (
  select m::date as month_start, exists(select 1 from public.user_practices up where up.user_id=uid and up.result='engaged' and up.sent_at >= m and up.sent_at < m + interval '1 month') as had_engaged,
   exists(select 1 from public.user_practices up where up.user_id=uid and up.delivery_status in ('sent','delivered') and up.sent_at >= m and up.sent_at < m + interval '1 month') as had_any
  from generate_series(date_trunc('month', range_start) - interval '23 months', date_trunc('month', range_start), interval '1 month') m
 )
 select jsonb_build_object(
  'received', (select count(*) from p),
  'by_channel', jsonb_build_object('email',(select count(*) from p where channel='email'),'text',(select count(*) from p where channel='text'),'phone',(select count(*) from p where channel='phone')),
  'spotted', (select count(*) from p where result in ('reported','declined')),
  'ignored', (select count(*) from p where result='no_observed_engagement'),
  'pending', (select count(*) from p where result='pending'),
  'inconclusive', (select count(*) from p where result='inconclusive'),
  'opportunities', coalesce((select jsonb_agg(jsonb_build_object('practice_id',id,'category',category,'name',name,'channel',channel,'coached',coaching_answer in ('correct','incorrect')) order by sent_at) from p where result='engaged'),'[]'),
  'coached', (select count(*) from p where coaching_answer in ('correct','incorrect')),
  'weak_spots', coalesce((select jsonb_agg(distinct s.category) from public.user_practices up join public.practice_scam_versions v on v.id=up.scam_version_id join public.practice_scams s on s.id=v.scam_id
                where up.user_id=uid and up.result='engaged' and up.sent_at >= range_end - interval '90 days' and up.sent_at < range_end),'[]'),
  'streak_months', (select count(*) from (select month_start, had_engaged, had_any, row_number() over (order by month_start desc) rn,
                     sum(case when had_engaged then 1 else 0 end) over (order by month_start desc rows unbounded preceding) seen from months) x where seen=0 and had_any),
  'last_month', jsonb_build_object('received',(select count(*) from prev),'spotted',(select count(*) from prev where result in ('reported','declined')),'opportunities',(select count(*) from prev where result='engaged'))
 ) $$;

-- Reports due now (service role, hourly): the monthly report for last month, generated on the 1st at 09:00 or later in
-- the participant's time zone, for anyone with an active participant seat for at least 14 days of that month; and
-- the shorter welcome report after a new participant's first two practices. Returns what the sender needs.
create function public.generate_due_reports() returns table(report_id uuid, participant_user_id uuid, kind text, month date, metrics jsonb, web_token text, participant_email text, participant_name text)
language plpgsql volatile security definer set search_path = '' as $$
declare r record; tz text; local_now timestamp; m date; tok text; rid uuid; met jsonb;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 -- Family emails carry signed stop links, so nothing is generated until the signing secret exists.
 if (select value from safekeep_private.secrets where name='report_links') is null then raise exception 'Set the report_links secret first'; end if;
 for r in
  select distinct on (sm.user_id) sm.user_id, sm.joined_at, coalesce(pf.timezone,'America/New_York') as tz, coalesce(pf.preferred_name,pf.first_name) as nm, u.email
  from public.subscription_members sm join public.subscriptions s on s.id=sm.subscription_id join auth.users u on u.id=sm.user_id
  left join public.user_profiles pf on pf.user_id=sm.user_id
  where sm.role='participant' and sm.status='active' and s.status in ('trialing','active','past_due')
   and not exists(select 1 from public.account_deletions d where d.user_id=sm.user_id and d.cancelled_at is null)
  order by sm.user_id, sm.joined_at
 loop
  tz := r.tz; local_now := now() at time zone tz;
  -- Monthly: last month, once it's 09:00 on the 1st or later.
  m := (date_trunc('month', local_now) - interval '1 month')::date;
  if local_now >= date_trunc('month', local_now) + interval '9 hours'
     and (r.joined_at at time zone tz) <= (m + interval '1 month' - interval '14 days')
     and not exists(select 1 from public.monthly_reports x where x.participant_user_id=r.user_id and x.month=m and x.kind='monthly') then
   met := safekeep_private.practice_metrics(r.user_id, (m::timestamp at time zone tz), ((m + interval '1 month')::timestamp at time zone tz));
   if (met->>'received')::int > 0 then
    tok := encode(extensions.gen_random_bytes(24),'hex');
    insert into public.monthly_reports(participant_user_id,month,kind,metrics,web_token_hash) values(r.user_id,m,'monthly',met,encode(extensions.digest(tok,'sha256'),'hex')) returning id into rid;
    report_id := rid; participant_user_id := r.user_id; kind := 'monthly'; month := m; metrics := met; web_token := tok; participant_email := r.email; participant_name := r.nm;
    return next;
   end if;
  end if;
  -- Welcome: once, after the first two practices have finished (so there's something to say).
  if not exists(select 1 from public.monthly_reports x where x.participant_user_id=r.user_id and x.kind='welcome')
     and not exists(select 1 from public.monthly_reports x where x.participant_user_id=r.user_id and x.kind='monthly')
     and (select count(*) from public.user_practices up where up.user_id=r.user_id and up.delivery_status in ('sent','delivered') and up.result<>'pending') >= 2 then
   m := date_trunc('month', local_now)::date;
   met := safekeep_private.practice_metrics(r.user_id, r.joined_at, now());
   tok := encode(extensions.gen_random_bytes(24),'hex');
   insert into public.monthly_reports(participant_user_id,month,kind,metrics,web_token_hash) values(r.user_id,m,'welcome',met,encode(extensions.digest(tok,'sha256'),'hex')) returning id into rid;
   report_id := rid; participant_user_id := r.user_id; kind := 'welcome'; month := m; metrics := met; web_token := tok; participant_email := r.email; participant_name := r.nm;
   return next;
  end if;
 end loop;
end $$;

-- Who reads a participant's report besides them: the people they added, each with a signed stop link. A sponsor is
-- included only if the participant added them; for a sponsor with more than one participant who chose them, the
-- sender combines those blocks into one email.
create function safekeep_private.report_sig(rid uuid) returns text language sql stable security definer set search_path = '' as $$
 select encode(extensions.hmac(rid::text, (select value from safekeep_private.secrets where name='report_links'), 'sha256'),'hex') $$;
create function public.report_family(uid uuid) returns table(recipient_id uuid, name text, email text, sig text, is_sponsor boolean)
language sql stable security definer set search_path = '' as $$
 select r.id, r.name, lower(r.email), safekeep_private.report_sig(r.id),
  exists(select 1 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id join auth.users u on u.id=s.sponsor_user_id
         where m.user_id=uid and m.role='participant' and m.status='active' and lower(u.email)=lower(r.email) and s.sponsor_user_id<>uid)
 from public.report_recipients r where r.participant_user_id=uid and r.removed_at is null $$;

create function public.mark_report_sent(rid uuid, who text) returns void language sql volatile security definer set search_path = '' as $$
 update public.monthly_reports set sent_to_participant_at=case when who='participant' then now() else sent_to_participant_at end,
  sent_to_family_at=case when who='family' then now() else sent_to_family_at end where id=rid $$;

-- A family member stops getting someone's report from the link in the email. The participant sees the change on
-- their account page.
create function public.report_unsubscribe(rid uuid, sig text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
 if sig is null or safekeep_private.report_sig(rid) is distinct from lower(sig) then return jsonb_build_object('saved',false); end if;
 update public.report_recipients set removed_at=now() where id=rid and removed_at is null;
 return jsonb_build_object('saved',true);
end $$;

-- The family web version of one report, by the token in its email: counts and categories only, never content.
create function public.report_by_token(token text) returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('kind',r.kind,'month',r.month,'name',coalesce(pf.preferred_name,pf.first_name,'Your family member'),
  'metrics', (r.metrics - 'opportunities') || jsonb_build_object('opportunities', coalesce((select jsonb_agg(jsonb_build_object('category',o->>'category')) from jsonb_array_elements(r.metrics->'opportunities') o),'[]')))
 from public.monthly_reports r left join public.user_profiles pf on pf.user_id=r.participant_user_id
 where r.web_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and r.generated_at > now() - interval '13 months' $$;

-- The participant's own reports on /account/: the last twelve, in full.
create function public.my_reports() returns table(month date, kind text, metrics jsonb, generated_at timestamptz) language sql stable security definer set search_path = '' as $$
 select month, kind, metrics, generated_at from public.monthly_reports where participant_user_id=auth.uid() order by month desc, generated_at desc limit 13 $$;

revoke all on function public.generate_due_reports(), public.report_family(uuid), public.mark_report_sent(uuid,text) from public, anon, authenticated;
grant execute on function public.generate_due_reports(), public.report_family(uuid), public.mark_report_sent(uuid,text) to service_role;
revoke all on function public.report_unsubscribe(uuid,text), public.report_by_token(text), public.my_reports() from public;
grant execute on function public.report_unsubscribe(uuid,text), public.report_by_token(text) to anon, authenticated;
grant execute on function public.my_reports() to authenticated;

-- The founders' view (PRD: Internal metrics), last 90 days: engagement by version, channel and difficulty, coaching
-- completion, time from send to first event, and consent withdrawals by channel.
create function public.admin_metrics() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if not safekeep_private.is_admin(auth.uid()) then raise exception 'Admins only' using errcode='42501'; end if;
 return (with p as (
   select up.*, v.difficulty as vdiff, s.name, v.version_number, v.format from public.user_practices up join public.practice_scam_versions v on v.id=up.scam_version_id join public.practice_scams s on s.id=v.scam_id
   where up.delivery_status in ('sent','delivered') and up.sent_at > now() - interval '90 days' and up.result<>'pending')
  select jsonb_build_object(
   'finished', (select count(*) from p),
   'by_channel', coalesce((select jsonb_agg(jsonb_build_object('channel',channel,'n',n,'engaged',e,'spotted',sp)) from (select channel, count(*) n, count(*) filter (where result='engaged') e, count(*) filter (where result in ('reported','declined')) sp from p group by channel) x),'[]'),
   'by_difficulty', coalesce((select jsonb_agg(jsonb_build_object('difficulty',vdiff,'n',n,'engaged',e) order by vdiff) from (select vdiff, count(*) n, count(*) filter (where result='engaged') e from p group by vdiff) x),'[]'),
   'by_version', coalesce((select jsonb_agg(jsonb_build_object('name',name,'format',format,'version',version_number,'n',n,'engaged',e) order by n desc) from (select name, format, version_number, count(*) n, count(*) filter (where result='engaged') e from p group by 1,2,3) x),'[]'),
   'coaching_completion', (select jsonb_build_object('engaged',count(*),'coached',count(*) filter (where coaching_answer in ('correct','incorrect'))) from p where result='engaged'),
   'median_minutes_to_first_event', (select round(extract(epoch from percentile_cont(0.5) within group (order by first_at - p.sent_at))/60) from p join lateral (select min(occurred_at) first_at from public.practice_events e where e.user_practice_id=p.id and e.event_type in ('link_clicked','replied','call_answered','reported','keypress')) f on f.first_at is not null),
   'withdrawals', coalesce((select jsonb_agg(jsonb_build_object('channel',channel,'n',n)) from (select channel, count(*) n from public.consent_events where action='revoke' and recorded_at > now() - interval '90 days' group by channel) x),'[]')));
end $$;
revoke all on function public.admin_metrics() from public, anon;
grant execute on function public.admin_metrics() to authenticated;
