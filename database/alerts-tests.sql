-- Tests for database/alerts.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into safekeep_private.secrets values('app_origin','https://joinsafekeep.com') on conflict(name) do update set value=excluded.value;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','sponsor@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','Mom@Example.invalid',now(),false),
('33333333-3333-4333-8333-333333333333','lapsed@example.invalid',now(),false),
('44444444-4444-4444-8444-444444444444','optedout@example.invalid',now(),false);
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,plan,billing,seats,status) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_t','sub_t','pairs','annual',2,'active'),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','33333333-3333-4333-8333-333333333333','cus_l','sub_l','individual','monthly',1,'canceled');
insert into public.subscription_members(subscription_id,user_id,role) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','sponsor'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','participant'),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444','participant');
insert into public.user_preferences(user_id,alerts_opt_in) values('11111111-1111-4111-8111-111111111111',true),('22222222-2222-4222-8222-222222222222',true),('33333333-3333-4333-8333-333333333333',true),('44444444-4444-4444-8444-444444444444',false);

-- Without the signing secret nothing can be claimed, so no email goes out with a broken unsubscribe link.
do $$ declare aid uuid; begin
 perform public.queue_alert('weekly-2026-11-02','This Week''s Scam Alert','2026-11-02','Subject','<p>hi</p>','hi');
 aid := (select id from public.alerts where slug='weekly-2026-11-02');
 begin perform public.claim_alert_recipients(aid); raise exception 'Claimed without secret'; exception when raise_exception then if sqlerrm='Claimed without secret' then raise; end if; end;
end $$;
insert into safekeep_private.secrets values('alerts_unsubscribe','test-secret') on conflict(name) do update set value=excluded.value;

-- Free list: subscribing queues one confirmation a day; only confirmed addresses are mailed.
set local role anon;
select public.alerts_subscribe('Friend@Example.invalid');
select public.alerts_subscribe('friend@example.invalid');
select public.alerts_subscribe('mom@example.invalid');
select public.alerts_subscribe('pending@example.invalid');
do $$ begin
 begin perform public.alerts_subscribe('not an email'); raise exception 'Bad email accepted'; exception when raise_exception then if sqlerrm='Bad email accepted' then raise; end if; end;
end $$;
reset role;
create temp table t(token text); grant all on t to anon;
insert into t select substring(body from '\?c=([0-9a-f]{48})') from public.outbound_emails where kind='alerts_confirm' and to_email='friend@example.invalid';
do $$ begin
 if (select count(*) from public.outbound_emails where kind='alerts_confirm' and to_email='friend@example.invalid')<>1 then raise exception 'Confirmation sent twice in a day'; end if;
end $$;
set local role anon;
do $$ begin
 if (public.alerts_confirm((select token from t))->>'saved')::boolean is not true then raise exception 'Confirm failed'; end if;
 if (public.alerts_confirm((select token from t))->>'saved')::boolean then raise exception 'Token reused'; end if;
end $$;
reset role;
-- Mom confirms her free-list copy too; she still gets one email, as a member.
update public.alert_subscribers set confirmed_at=now() where email='mom@example.invalid';

-- Recipients: sponsor and participant with alerts on, plus the confirmed free-list address. Not the lapsed sponsor,
-- the member who turned alerts off, or the unconfirmed address. Claiming twice returns nobody new.
create temp table r as select * from public.claim_alert_recipients((select id from public.alerts where slug='weekly-2026-11-02'));
grant select on r to anon;
do $$ begin
 if (select array_agg(email order by email) from r)<>array['friend@example.invalid','mom@example.invalid','sponsor@example.invalid'] then raise exception 'Recipients wrong: %', (select array_agg(email order by email) from r); end if;
 if (select kind from r where email='mom@example.invalid')<>'member' then raise exception 'Member counted as free list'; end if;
 if exists(select 1 from public.claim_alert_recipients((select id from public.alerts where slug='weekly-2026-11-02'))) then raise exception 'Claimed twice'; end if;
 perform public.mark_alert_batch((select id from public.alerts where slug='weekly-2026-11-02'),array['friend@example.invalid','mom@example.invalid','sponsor@example.invalid'],true);
 perform public.finish_alert((select id from public.alerts where slug='weekly-2026-11-02'));
 if (select recipient_count from public.alerts where slug='weekly-2026-11-02')<>3 or (select status from public.alerts where slug='weekly-2026-11-02')<>'sent' then raise exception 'Alert not finished'; end if;
 -- A redeploy doesn't send it again.
 if public.queue_alert('weekly-2026-11-02','x','2026-11-02','s','h','p')<>'sent' then raise exception 'Requeued a sent alert'; end if;
end $$;

-- Unsubscribe: a good signature turns off the member's alert setting only; a bad one does nothing.
set local role anon;
do $$ declare good text := (select sig from r where email='mom@example.invalid'); begin
 if (public.alerts_unsubscribe('mom@example.invalid', repeat('0',64))->>'saved')::boolean then raise exception 'Bad signature accepted'; end if;
 if (public.alerts_unsubscribe('MOM@example.invalid', good)->>'saved')::boolean is not true then raise exception 'Unsubscribe failed'; end if;
end $$;
reset role;
do $$ begin
 if (select alerts_opt_in from public.user_preferences where user_id='22222222-2222-4222-8222-222222222222') then raise exception 'Member still opted in'; end if;
 if (select unsubscribed_at from public.alert_subscribers where email='mom@example.invalid') is null then raise exception 'Free-list row not unsubscribed'; end if;
 if (select alerts_opt_in from public.user_preferences where user_id='11111111-1111-4111-8111-111111111111') is not true then raise exception 'Someone else unsubscribed'; end if;
end $$;

-- Nobody signed in can read the pipeline tables or claim recipients.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 begin perform 1 from public.alert_subscribers; raise exception 'Subscriber list readable'; exception when insufficient_privilege then null; end;
 begin perform public.claim_alert_recipients((select gen_random_uuid())); raise exception 'Claim allowed'; exception when insufficient_privilege then null; end;
 begin perform public.admin_alerts(); raise exception 'Non-admin saw alerts'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'Alert tests passed; fixtures rolled back' as result;
