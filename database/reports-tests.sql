-- Tests for database/reports.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into safekeep_private.secrets values('app_origin','https://joinsafekeep.com') on conflict(name) do update set value=excluded.value;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','ian@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','mom@example.invalid',now(),false),
('33333333-3333-4333-8333-333333333333','newdad@example.invalid',now(),false);
insert into public.user_profiles(user_id,first_name,timezone,adult_confirmed_at) values
('22222222-2222-4222-8222-222222222222','Margaret','America/Chicago',now()),('33333333-3333-4333-8333-333333333333','Walter','America/Denver',now());
insert into public.admin_users(user_id) values('11111111-1111-4111-8111-111111111111');
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,plan,billing,seats,status)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_t','sub_t','family','annual',4,'active');
insert into public.subscription_members(subscription_id,user_id,role,joined_at) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','participant',now()-interval '90 days'),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','participant',now()-interval '5 days');
insert into public.user_contacts(id,user_id,kind,normalized_value,verified_at) values
('c1111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','mobile','+15555550101',now()),
('c3333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333','email','newdad@example.invalid',now());
insert into public.report_recipients(id,participant_user_id,email,name,added_by_user_id) values
('f1111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Ian@Example.invalid','Ian','22222222-2222-4222-8222-222222222222'),
('f2222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','sister@example.invalid','Ruth','22222222-2222-4222-8222-222222222222');
insert into public.practice_scams(id,stable_code,name,category) values('d1111111-1111-4111-8111-111111111111','test-delivery','Parcel fee','delivery'),('d2222222-2222-4222-8222-222222222222','test-bank','Bank locked','bank');
insert into public.practice_scam_versions(id,scam_id,version_number,format,difficulty,content,learning_objective,debrief,status) values
('e1111111-1111-4111-8111-111111111111','d1111111-1111-4111-8111-111111111111',1,'text',1,'c','x','y','published'),
('e2222222-2222-4222-8222-222222222222','d2222222-2222-4222-8222-222222222222',1,'text',2,'c','x','y','published');
-- Last month (in Margaret's time zone): four practices. Spotted one, ignored one, one practice opportunity she was
-- coached on, and one still pending at the time. This month: one more, which last month's report must not count.
create temp table lm as select ((date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month') at time zone 'America/Chicago') as start;
insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,sent_at,delivery_status,channel,result,coaching_answer)
select '22222222-2222-4222-8222-222222222222', v, 'c1111111-1111-4111-8111-111111111111', lm.start + d, lm.start + d, 'delivered', 'text', res, ans
from lm, (values ('e1111111-1111-4111-8111-111111111111'::uuid, interval '2 days', 'reported', null),
                 ('e2222222-2222-4222-8222-222222222222'::uuid, interval '9 days', 'engaged', 'correct'),
                 ('e1111111-1111-4111-8111-111111111111'::uuid, interval '16 days', 'no_observed_engagement', null),
                 ('e2222222-2222-4222-8222-222222222222'::uuid, interval '23 days', 'declined', null)) x(v, d, res, ans);
insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,sent_at,delivery_status,channel,result)
values('22222222-2222-4222-8222-222222222222','e1111111-1111-4111-8111-111111111111','c1111111-1111-4111-8111-111111111111',now(),now(),'sent','text','pending');
-- Walter is new: two finished practices so far.
insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,sent_at,delivery_status,channel,result) values
('33333333-3333-4333-8333-333333333333','e1111111-1111-4111-8111-111111111111','c3333333-3333-4333-8333-333333333333',now()-interval '3 days',now()-interval '3 days','delivered','email','reported'),
('33333333-3333-4333-8333-333333333333','e2222222-2222-4222-8222-222222222222','c3333333-3333-4333-8333-333333333333',now()-interval '1 day',now()-interval '1 day','delivered','email','no_observed_engagement');

-- The numbers.
do $$ declare m jsonb := safekeep_private.practice_metrics('22222222-2222-4222-8222-222222222222',(select start from lm),(select start from lm)+interval '1 month'); begin
 if (m->>'received')::int<>4 or (m->'by_channel'->>'text')::int<>4 then raise exception 'Received wrong: %', m; end if;
 if (m->>'spotted')::int<>2 then raise exception 'Spotted should count reported and declined: %', m; end if;
 if (m->>'ignored')::int<>1 or jsonb_array_length(m->'opportunities')<>1 or (m->>'coached')::int<>1 then raise exception 'Counts wrong: %', m; end if;
 if m->'opportunities'->0->>'category'<>'bank' or m->'weak_spots'<>'["bank"]'::jsonb then raise exception 'Categories wrong: %', m; end if;
end $$;

-- Nothing is generated until the stop-link secret exists.
do $$ begin begin perform public.generate_due_reports(); raise exception 'Generated without secret'; exception when raise_exception then if sqlerrm='Generated without secret' then raise; end if; end; end $$;
insert into safekeep_private.secrets values('report_links','test-report-secret') on conflict(name) do update set value=excluded.value;

-- Margaret gets last month's report; Walter (joined five days ago) gets the welcome report instead. Running again
-- makes nothing new.
create temp table due as select * from public.generate_due_reports();
grant select on due to anon;
do $$ begin
 if (select count(*) from due)<>2 then raise exception 'Expected two reports, got %', (select count(*) from due); end if;
 if (select kind from due where participant_user_id='22222222-2222-4222-8222-222222222222')<>'monthly' then raise exception 'Monthly missing'; end if;
 if (select (metrics->>'received')::int from due where participant_user_id='22222222-2222-4222-8222-222222222222')<>4 then raise exception 'This month leaked into last month'; end if;
 if (select kind from due where participant_user_id='33333333-3333-4333-8333-333333333333')<>'welcome' then raise exception 'Welcome missing'; end if;
 if (select participant_email from due where participant_user_id='33333333-3333-4333-8333-333333333333')<>'newdad@example.invalid' then raise exception 'Email missing'; end if;
 if exists(select 1 from public.generate_due_reports()) then raise exception 'Generated twice'; end if;
end $$;

-- Readers: the sponsor (Ian) is marked so his copy can be combined; each has a working stop link.
create temp table fam as select * from public.report_family('22222222-2222-4222-8222-222222222222');
grant select on fam to anon;
do $$ begin
 if (select count(*) from fam)<>2 or not (select is_sponsor from fam where email='ian@example.invalid') or (select is_sponsor from fam where email='sister@example.invalid') then raise exception 'Readers wrong'; end if;
end $$;

-- The family web view: counts and categories, never the name of a practice.
set local role anon;
do $$ declare r jsonb := public.report_by_token((select web_token from due where participant_user_id='22222222-2222-4222-8222-222222222222')); begin
 if r->>'name'<>'Margaret' or (r->'metrics'->>'received')::int<>4 then raise exception 'Family view wrong: %', r; end if;
 if r::text like '%Bank locked%' or r->'metrics'->'opportunities'->0 ? 'practice_id' then raise exception 'Family view shows practice content'; end if;
 if public.report_by_token(repeat('0',48)) is not null then raise exception 'Wrong token opened a report'; end if;
 if (public.report_unsubscribe('f2222222-2222-4222-8222-222222222222', repeat('0',64))->>'saved')::boolean then raise exception 'Bad signature accepted'; end if;
 if (public.report_unsubscribe('f2222222-2222-4222-8222-222222222222', (select sig from fam where email='sister@example.invalid'))->>'saved')::boolean is not true then raise exception 'Unsubscribe failed'; end if;
end $$;
reset role;
do $$ begin if (select removed_at from public.report_recipients where id='f2222222-2222-4222-8222-222222222222') is null then raise exception 'Reader not removed'; end if; end $$;

-- Margaret sees her reports in full on her account page; Ian, signed in, sees none of hers but can see the
-- founders' numbers as an admin.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 if (select count(*) from public.my_reports())<>1 or (select metrics->'opportunities'->0->>'name' from public.my_reports())<>'Bank locked' then raise exception 'Participant reports wrong'; end if;
 begin perform public.admin_metrics(); raise exception 'Participant saw admin metrics'; exception when insufficient_privilege then null; end;
 begin perform public.generate_due_reports(); raise exception 'Participant generated reports'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 if exists(select 1 from public.my_reports()) then raise exception 'Sponsor sees participant reports'; end if;
 if (public.admin_metrics()->>'finished')::int<>6 then raise exception 'Admin metrics wrong: %', public.admin_metrics(); end if;
end $$;
rollback;
select 'Report tests passed; fixtures rolled back' as result;
