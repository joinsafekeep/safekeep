-- Migration: scam_alerts_engine
-- Phase 5 of the MVP PRD ("Alerts engine"): fetched source items, the alert record from draft to sent, the free
-- alerts-only list, per-recipient send ledger, and one-click unsubscribe that is separate from practice consent.
-- Apply after practice.sql.

create table public.source_items (
 id uuid primary key default gen_random_uuid(),
 url text not null unique check(url ~ '^https://'),
 publisher text not null, kind text not null default 'primary' check(kind in ('primary','news')), title text not null, published_at timestamptz, fetched_at timestamptz not null default now(),
 content_hash text not null unique, text text not null check(length(text) <= 200000),
 used_in_alert_id uuid
);
create index source_items_recent_idx on public.source_items(published_at desc);

create table public.alerts (
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check(slug ~ '^[a-z0-9-]{3,120}$'),
 week_of date not null,
 status text not null default 'drafted' check(status in ('drafted','in_review','published','sending','sent','failed')),
 title text, pr_url text, check_report jsonb not null default '{}',
 email_subject text, email_html text, email_text text,
 created_at timestamptz not null default now(), published_at timestamptz, sent_at timestamptz, recipient_count int not null default 0
);
alter table public.source_items add constraint source_items_alert_fk foreign key(used_in_alert_id) references public.alerts(id) on delete set null;
alter table public.practice_scam_versions add constraint practice_scam_versions_alert_fk foreign key(source_item_id) references public.source_items(id) on delete set null;
alter table public.practice_scam_versions add column source_alert_id uuid references public.alerts(id) on delete set null;

-- The free alerts-only list (people who haven't subscribed). Double opt-in: a row is only mailed once confirmed.
create table public.alert_subscribers (
 id uuid primary key default gen_random_uuid(),
 email text not null unique check(email = lower(email) and length(email) <= 254),
 source text not null default 'site', created_at timestamptz not null default now(),
 confirm_token_hash text unique, confirm_sent_at timestamptz, confirmed_at timestamptz, unsubscribed_at timestamptz
);
-- One row per alert per address, written before the send, so a retried batch never mails anyone twice.
create table public.alert_sends (
 alert_id uuid not null references public.alerts(id) on delete cascade,
 email text not null, kind text not null check(kind in ('member','free')),
 claimed_at timestamptz not null default now(), sent_at timestamptz, failed_at timestamptz,
 primary key(alert_id, email)
);
alter table public.outbound_emails drop constraint outbound_emails_kind_check;
alter table public.outbound_emails add constraint outbound_emails_kind_check check(kind in ('subscription_ended','participant_left','payment_failed','participant_removed','invitation','invitation_accepted','invitation_declined','invitation_expired','invitation_reminder','practice_paused','coaching_share','alerts_confirm'));

alter table public.source_items enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_subscribers enable row level security;
alter table public.alert_sends enable row level security;
revoke all on public.source_items, public.alerts, public.alert_subscribers, public.alert_sends from public, anon, authenticated;
grant all on public.source_items, public.alerts, public.alert_subscribers, public.alert_sends to service_role;

-- Unsubscribe links are signed, so they work without a login and without storing a token per send:
-- sig = hex(hmac_sha256(lower(email), secret 'alerts_unsubscribe')).
create function safekeep_private.alerts_sig(addr text) returns text language sql stable security definer set search_path = '' as $$
 select encode(extensions.hmac(lower(trim(addr)), (select value from safekeep_private.secrets where name='alerts_unsubscribe'), 'sha256'),'hex') $$;

-- Who gets this week's alert: members (an active participant seat, or a sponsor with a live plan) who have the
-- weekly alert turned on and aren't deleting their account, plus confirmed free-list subscribers. One row per
-- address, members first, and only addresses not yet claimed for this alert.
create function public.claim_alert_recipients(aid uuid, lim int default 500) returns table(email text, kind text, sig text)
language plpgsql volatile security definer set search_path = '' as $$
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 if (select value from safekeep_private.secrets where name='alerts_unsubscribe') is null then raise exception 'Set the alerts_unsubscribe secret first'; end if;
 return query
 with members as (
  select distinct lower(u.email) as email from auth.users u join public.user_preferences pr on pr.user_id=u.id
  where pr.alerts_opt_in and u.email is not null and u.email_confirmed_at is not null
   and not exists(select 1 from public.account_deletions d where d.user_id=u.id and d.cancelled_at is null)
   and (exists(select 1 from public.subscription_members m join public.subscriptions s on s.id=m.subscription_id where m.user_id=u.id and m.role='participant' and m.status='active' and s.status in ('trialing','active','past_due'))
     or exists(select 1 from public.subscriptions s where s.sponsor_user_id=u.id and s.status in ('trialing','active','past_due')))
 ), everyone as (
  select m.email, 'member' as kind from members m
  union all
  select f.email, 'free' from public.alert_subscribers f where f.confirmed_at is not null and f.unsubscribed_at is null and not exists(select 1 from members m where m.email=f.email)
 ), claimed as (
  insert into public.alert_sends(alert_id,email,kind)
  select aid, e.email, e.kind from everyone e where not exists(select 1 from public.alert_sends s where s.alert_id=aid and s.email=e.email) limit lim
  on conflict do nothing returning alert_sends.email, alert_sends.kind
 )
 select c.email, c.kind, safekeep_private.alerts_sig(c.email) from claimed c;
end $$;

create function public.mark_alert_batch(aid uuid, addresses text[], ok boolean) returns void language sql volatile security definer set search_path = '' as $$
 update public.alert_sends set sent_at=case when ok then now() end, failed_at=case when ok then null else now() end where alert_id=aid and email=any(addresses) $$;

-- The deploy that publishes an alert hands it here with its email; the sender picks up anything 'sending'.
create function public.queue_alert(alert_slug text, alert_title text, published date, subject text, html text, plain text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare a public.alerts;
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 insert into public.alerts(slug,week_of,title,status) values(alert_slug,published,alert_title,'published') on conflict(slug) do nothing;
 select * into a from public.alerts where slug=alert_slug for update;
 if a.status in ('sending','sent') then return a.status; end if;
 update public.alerts set status='sending', title=alert_title, published_at=coalesce(published_at,now()), email_subject=subject, email_html=html, email_text=plain where id=a.id;
 return 'sending';
end $$;

create function public.finish_alert(aid uuid) returns void language sql volatile security definer set search_path = '' as $$
 update public.alerts set status='sent', sent_at=now(), recipient_count=(select count(*) from public.alert_sends where alert_id=aid and sent_at is not null) where id=aid and status='sending' $$;

-- Free list: subscribe (queues a confirmation email at most once a day per address), confirm, unsubscribe.
create function public.alerts_subscribe(addr text, src text default 'site') returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sub public.alert_subscribers; tok text;
begin
 addr := lower(trim(coalesce(addr,'')));
 if addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(addr) > 254 then raise exception 'Enter a valid email address'; end if;
 select * into sub from public.alert_subscribers where email=addr for update;
 if found and sub.confirmed_at is not null and sub.unsubscribed_at is null then return jsonb_build_object('saved',true); end if;
 if found and sub.confirm_sent_at > now() - interval '24 hours' then return jsonb_build_object('saved',true); end if;
 tok := encode(extensions.gen_random_bytes(24),'hex');
 insert into public.alert_subscribers(email,source,confirm_token_hash,confirm_sent_at) values(addr,left(coalesce(src,'site'),40),encode(extensions.digest(tok,'sha256'),'hex'),now())
 on conflict(email) do update set confirm_token_hash=excluded.confirm_token_hash, confirm_sent_at=now();
 insert into public.outbound_emails(to_email,subject,body,kind) values(addr,'Confirm your weekly Scam Alert',
  'Hello,'||E'\n\n'||'Someone, hopefully you, asked for Safekeep''s weekly Scam Alert at this address. To start getting it, open this link:'||E'\n'||safekeep_private.app_origin()||'/scam-alerts/subscribe/?c='||tok||E'\n\n'||'If this wasn''t you, ignore this email and nothing more will be sent.'||E'\n\n'||'The Safekeep team','alerts_confirm');
 return jsonb_build_object('saved',true);
end $$;
create function public.alerts_confirm(token text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sub public.alert_subscribers;
begin
 update public.alert_subscribers set confirmed_at=now(), unsubscribed_at=null, confirm_token_hash=null
 where confirm_token_hash=encode(extensions.digest(coalesce(token,''),'sha256'),'hex') and confirm_sent_at > now() - interval '7 days' returning * into sub;
 return jsonb_build_object('saved', found);
end $$;
-- Unsubscribing a member turns off their weekly-alert setting and nothing else (practice carries on); for the free
-- list it marks the row. Either way the signature has to match.
create function public.alerts_unsubscribe(addr text, sig text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0; m int := 0;
begin
 addr := lower(trim(coalesce(addr,'')));
 if sig is null or safekeep_private.alerts_sig(addr) is distinct from lower(sig) then return jsonb_build_object('saved',false); end if;
 update public.user_preferences set alerts_opt_in=false where user_id in (select id from auth.users where lower(email)=addr) and alerts_opt_in;
 get diagnostics n = row_count;
 update public.alert_subscribers set unsubscribed_at=now() where email=addr and unsubscribed_at is null;
 get diagnostics m = row_count;
 return jsonb_build_object('saved',true);
end $$;

revoke all on function public.claim_alert_recipients(uuid,int), public.mark_alert_batch(uuid,text[],boolean), public.queue_alert(text,text,date,text,text,text), public.finish_alert(uuid) from public, anon, authenticated;
grant execute on function public.claim_alert_recipients(uuid,int), public.mark_alert_batch(uuid,text[],boolean), public.queue_alert(text,text,date,text,text,text), public.finish_alert(uuid) to service_role;
revoke all on function public.alerts_subscribe(text,text), public.alerts_confirm(text), public.alerts_unsubscribe(text,text) from public;
grant execute on function public.alerts_subscribe(text,text), public.alerts_confirm(text), public.alerts_unsubscribe(text,text) to anon, authenticated;

-- Admin view of the alerts pipeline (admins only; checked here, like admin_action).
create function public.admin_alerts() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if not safekeep_private.is_admin(auth.uid()) then raise exception 'Admins only' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('slug',a.slug,'title',a.title,'week_of',a.week_of,'status',a.status,'pr_url',a.pr_url,'check_report',a.check_report,'published_at',a.published_at,'sent_at',a.sent_at,'recipient_count',a.recipient_count,
  'claimed',(select count(*) from public.alert_sends s where s.alert_id=a.id),'failed',(select count(*) from public.alert_sends s where s.alert_id=a.id and s.failed_at is not null)) order by a.created_at desc),'[]')
 from (select * from public.alerts order by created_at desc limit 12) a);
end $$;
revoke all on function public.admin_alerts() from public, anon;
grant execute on function public.admin_alerts() to authenticated;
