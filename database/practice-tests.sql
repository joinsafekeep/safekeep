-- Tests for database/practice.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into safekeep_private.secrets values('app_origin','https://joinsafekeep.com') on conflict(name) do update set value=excluded.value;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','sponsor@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','mom@example.invalid',now(),false),
('99999999-9999-4999-8999-999999999999','ian@example.invalid',now(),false);
insert into public.user_profiles(user_id,first_name,timezone,adult_confirmed_at) values
('11111111-1111-4111-8111-111111111111','Ian','America/New_York',now()),('22222222-2222-4222-8222-222222222222','Margaret','America/Chicago',now());
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,plan,billing,seats,status)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_t','sub_t','pairs','annual',2,'active');
insert into public.subscription_members(subscription_id,user_id,role) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','sponsor'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','participant');
insert into public.user_contacts(id,user_id,kind,normalized_value,verified_at) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222','email','mom@example.invalid',now());
insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','email','grant','v','test');
-- Quiet hours placed around the current moment so the test never runs inside them: allowed from three hours ago
-- until three hours from now, in Margaret's time zone.
insert into public.user_preferences(user_id,practice_enabled,max_practices_per_week,quiet_hours_start,quiet_hours_end)
values('22222222-2222-4222-8222-222222222222',true,7,((now() at time zone 'America/Chicago') + interval '3 hours')::time,((now() at time zone 'America/Chicago') - interval '3 hours')::time);
insert into public.admin_users(user_id) values('99999999-9999-4999-8999-999999999999');
-- Two scenarios, one draft email version each.
insert into public.practice_scams(id,stable_code,name,category) values
('d1111111-1111-4111-8111-111111111111','delivery-fee','Parcel redelivery fee','delivery'),('d2222222-2222-4222-8222-222222222222','bank-safe-account','Bank "safe account"','bank');
insert into public.practice_scam_versions(id,scam_id,version_number,format,difficulty,subject,content,learning_objective,debrief,tells,channel_variant,next_steps,question) values
('e1111111-1111-4111-8111-111111111111','d1111111-1111-4111-8111-111111111111',1,'email',1,'Your parcel is on hold','We tried to deliver your parcel. Pay the $1.99 redelivery fee within 24 hours: {link}','Delivery fees by email are a trick','Real carriers don''t ask for fees by email.',
 '[{"quote":"$1.99 redelivery fee","note":"Carriers don''t charge to redeliver."},{"quote":"within 24 hours","note":"The rush is there so you don''t stop to check."}]','{"from_name":"Parcel Delivery Notice","from_local":"notices"}',array['Delete it.','Check the tracking number on the shop''s own site.'],
 '{"prompt":"If this had been real, what would have been the first sign?","choices":["The fee","The greeting","The time of day"],"correct":0,"affirm":"Yes. A fee to redeliver is the giveaway.","gently":"Close. The fee is the first sign: carriers don''t charge to redeliver."}'),
('e2222222-2222-4222-8222-222222222222','d2222222-2222-4222-8222-222222222222',1,'email',4,'Urgent: unusual activity','Move your savings to a safe account today.','Banks never ask you to move money','No bank asks you to move money to keep it safe.','[]','{"from_name":"Account Security Team"}','{}',null);

-- Nothing is sent from a draft: the planner finds nothing until an admin approves.
select set_config('request.jwt.claim.sub','',true);
do $$ begin if public.plan_practices()<>0 then raise exception 'Planned from a draft'; end if; end $$;

-- Only admins see the queue and approve.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 begin perform public.admin_action('approve','{"version_id":"e1111111-1111-4111-8111-111111111111"}'); raise exception 'Participant approved'; exception when insufficient_privilege then null; end;
 begin perform public.plan_practices(); raise exception 'Participant ran the planner'; exception when insufficient_privilege then null; end;
 if public.am_i_admin() then raise exception 'Participant is admin'; end if;
end $$;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
do $$ begin
 if jsonb_array_length(public.admin_action('queue'))<>2 then raise exception 'Queue should list both drafts'; end if;
 perform public.admin_action('approve','{"version_id":"e1111111-1111-4111-8111-111111111111"}');
 perform public.admin_action('reject','{"version_id":"e2222222-2222-4222-8222-222222222222","note":"too hard for launch"}');
 if jsonb_array_length(public.admin_action('queue'))<>0 then raise exception 'Queue not cleared'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 if (select approved_by_user_id from public.practice_scam_versions where id='e1111111-1111-4111-8111-111111111111')<>'99999999-9999-4999-8999-999999999999' then raise exception 'Approver not recorded'; end if;
 if (select status from public.practice_scam_versions where id='e2222222-2222-4222-8222-222222222222')<>'retired' then raise exception 'Rejected draft still a draft'; end if;
end $$;

-- The planner schedules one practice, outside quiet hours, and only one at a time.
do $$ declare p public.user_practices; begin
 if public.plan_practices()<>1 then raise exception 'Expected one planned practice'; end if;
 if public.plan_practices()<>0 then raise exception 'Planned a second while one is waiting'; end if;
 select * into p from public.user_practices;
 if p.channel<>'email' or p.difficulty_at_send<>1 or p.delivery_status<>'scheduled' then raise exception 'Planned row wrong: %', row_to_json(p); end if;
 if safekeep_private.in_quiet_hours(p.scheduled_at,'America/Chicago',(select quiet_hours_start from public.user_preferences),(select quiet_hours_end from public.user_preferences)) then raise exception 'Scheduled inside quiet hours'; end if;
 if p.scheduled_at < now() then raise exception 'Scheduled in the past'; end if;
end $$;

-- Not due yet: nothing is claimed.
do $$ begin if exists(select 1 from public.claim_due_practices('email')) then raise exception 'Claimed early'; end if; end $$;

-- Consent withdrawn after planning: the pre-send check cancels it.
update public.user_practices set scheduled_at=now()-interval '1 minute';
insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','email','revoke','v','test');
do $$ begin
 if exists(select 1 from public.claim_due_practices('email')) then raise exception 'Sent without consent'; end if;
 if (select cancel_reason from public.user_practices)<>'no consent' then raise exception 'Wrong cancel reason: %', (select cancel_reason from public.user_practices); end if;
end $$;
-- Paused, deleting, unverified: each blocks too.
insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','email','grant','v','test');
delete from public.user_practices;
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute';
update public.user_preferences set paused_until=current_date+7;
do $$ begin
 if exists(select 1 from public.claim_due_practices('email')) then raise exception 'Sent while paused'; end if;
 if (select cancel_reason from public.user_practices)<>'paused' then raise exception 'Pause not the reason'; end if;
end $$;
update public.user_preferences set paused_until=null;
delete from public.user_practices;

-- A clean send: queued with a token, sent, and the token opens the coaching page without signing in.
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute';
create temp table t(token text, share text);
grant all on t to anon, authenticated;
insert into t(token) select token from public.claim_due_practices('email');
do $$ declare pid uuid := (select id from public.user_practices); begin
 if (select token from t) !~ '^[0-9a-f]{48}$' then raise exception 'Token missing'; end if;
 if (select delivery_status from public.user_practices)<>'queued' then raise exception 'Not queued'; end if;
 if (select access_token_hash from public.user_practices)=(select token from t) then raise exception 'Token stored in readable form'; end if;
 perform public.mark_practice_sent(pid,'sg-msg-1');
 perform public.mark_practice_delivered(pid,'sg-evt-1');
 perform public.mark_practice_delivered(pid,'sg-evt-1');
 if (select delivery_status from public.user_practices)<>'delivered' then raise exception 'Not delivered'; end if;
 if (select observation_ends_at from public.user_practices) < now()+interval '71 hours' then raise exception 'Observation window wrong'; end if;
 if (select count(*) from public.practice_events where event_type='delivered')<>1 then raise exception 'Duplicate delivered event'; end if;
end $$;
-- While it's still pending, the history doesn't show it, so the list can't be used to check a message.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin if exists(select 1 from public.my_practice_history()) then raise exception 'Pending practice listed'; end if; end $$;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ declare c jsonb; a jsonb; begin
 if public.coaching_view(repeat('0',48)) is not null then raise exception 'Wrong token opened a page'; end if;
 c := public.coaching_view((select token from t));
 if c->>'result'<>'engaged' then raise exception 'Click not recorded as a practice opportunity'; end if;
 if c->'question'->>'correct' is not null or c->'answer' <> 'null'::jsonb then raise exception 'Answer leaked before answering'; end if;
 if jsonb_array_length(c->'tells')<>2 then raise exception 'Tells missing'; end if;
 perform public.coaching_view((select token from t));
 a := public.coaching_answer((select token from t), 2);
 if (a->>'correct')::boolean or a->>'message' not like 'Close.%' then raise exception 'Wrong answer not corrected gently'; end if;
 -- The first answer is the one kept.
 perform public.coaching_answer((select token from t), 0);
end $$;
reset role;
do $$ begin
 if (select count(*) from public.practice_events where event_type='link_clicked')<>1 then raise exception 'Click counted twice'; end if;
 if (select count(*) from public.practice_events where event_type='coaching_viewed')<>2 then raise exception 'Views not recorded'; end if;
 if (select coaching_answer from public.user_practices)<>'incorrect' then raise exception 'First answer not kept'; end if;
 if (select count(*) from public.practice_events where event_type='debrief_completed')<>1 then raise exception 'Debrief counted twice'; end if;
end $$;

-- Sharing: each family member gets a separate link that shows the page but nothing about the outcome, and can't
-- stop practice or answer. Three shares at most.
set local role anon;
do $$ begin
 perform public.coaching_share((select token from t),'Daughter@Example.invalid','Sarah','');
 perform public.coaching_share((select token from t),'son@example.invalid','Tom','Mom');
 perform public.coaching_share((select token from t),'aunt@example.invalid','','');
 begin perform public.coaching_share((select token from t),'fourth@example.invalid','',''); raise exception 'Fourth share allowed'; exception when raise_exception then if sqlerrm='Fourth share allowed' then raise; end if; end;
end $$;
reset role;
update t set share=(select substring(body from '/p/([0-9a-f]{48})') from public.outbound_emails where kind='coaching_share' and to_email='daughter@example.invalid');
set local role anon;
do $$ declare c jsonb; begin
 c := public.coaching_view((select share from t));
 if c is null or (c->>'shared')::boolean is not true then raise exception 'Shared page did not open'; end if;
 if c->>'result' is not null or c->>'practice_id' is not null or c->'question' <> 'null'::jsonb then raise exception 'Shared view shows too much'; end if;
 if (public.stop_by_token((select share from t))->>'saved')::boolean then raise exception 'Share token stopped practice'; end if;
 if public.coaching_answer((select share from t),0) is not null then raise exception 'Share token answered'; end if;
end $$;
reset role;
do $$ begin
 if (select body from public.outbound_emails where to_email='daughter@example.invalid') not like 'Hello Sarah,%Margaret practises spotting scams%' then raise exception 'Share email wording'; end if;
 if (select subject from public.outbound_emails where to_email='son@example.invalid') not like 'Mom wanted%' then raise exception 'Share uses the name they gave'; end if;
 if (select count(*) from public.practice_events where event_type='coaching_shared')<>3 then raise exception 'Shares not recorded'; end if;
end $$;

-- Once its outcome is known it appears in the history, and can be reopened from the account after the link expires.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 if (select result from public.my_practice_history())<>'engaged' then raise exception 'History missing the practice'; end if;
 if (public.practice_action('view',jsonb_build_object('practice_id',(select practice_id from public.my_practice_history())))->>'name')<>'Parcel redelivery fee' then raise exception 'Account view failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 if exists(select 1 from public.my_practice_history()) then raise exception 'Sponsor sees participant history'; end if;
 begin perform public.practice_action('view',jsonb_build_object('practice_id',(select id from public.user_practices limit 1))); raise exception 'Sponsor opened coaching'; exception when insufficient_privilege then null; when others then if sqlerrm='Sponsor opened coaching' then raise; end if; end;
end $$;
reset role;

-- The same scam isn't sent again within 180 days: with only that one published, the planner has nothing to send.
select set_config('request.jwt.claim.sub','',true);
do $$ begin if public.plan_practices()<>0 then raise exception 'Repeated a scam inside 180 days'; end if; end $$;

-- "Was this Safekeep?": a pending practice reported from the account becomes "spotted it".
update public.user_practices set created_at=now()-interval '200 days', sent_at=now()-interval '200 days';
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
do $$ declare pid uuid; begin
 select practice_id into pid from public.claim_due_practices('email');
 perform public.mark_practice_sent(pid,'sg-msg-2');
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ declare r jsonb; begin
 r := public.practice_action('was_this_safekeep','{"channel":"text","when":"today"}');
 if (r->>'ours')::boolean then raise exception 'Claimed a text we never sent'; end if;
 r := public.practice_action('was_this_safekeep','{"channel":"email","when":"today"}');
 if not (r->>'ours')::boolean or r->'coaching'->>'result'<>'reported' then raise exception 'Report not recorded: %', r; end if;
end $$;
reset role;

-- A temporary failure retries once; a bounce suppresses the contact, pauses that channel and tells both people.
select set_config('request.jwt.claim.sub','',true);
update public.user_practices set created_at=now()-interval '400 days', sent_at=now()-interval '400 days';
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
do $$ declare pid uuid; begin
 select practice_id into pid from public.claim_due_practices('email');
 perform public.mark_practice_failed(pid,'timeout',false);
 if (select delivery_status from public.user_practices where id=pid)<>'scheduled' or (select retries from public.user_practices where id=pid)<>1 then raise exception 'Temporary failure not retried'; end if;
 update public.user_practices set scheduled_at=now()-interval '1 minute' where id=pid;
 perform 1 from public.claim_due_practices('email');
 perform public.mark_practice_failed(pid,'timeout again',false);
 if (select delivery_status from public.user_practices where id=pid)<>'failed' then raise exception 'Retried more than once'; end if;
 perform public.mark_practice_failed(pid,'bounce',true);
end $$;
do $$ begin
 if (select suppressed_at from public.user_contacts where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') is not null then raise exception 'Suppressed on a failed row'; end if;
end $$;
-- A bounce on a sent message is the permanent case.
update public.user_practices set created_at=now()-interval '400 days', sent_at=now()-interval '400 days';
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
do $$ declare pid uuid; begin
 select practice_id into pid from public.claim_due_practices('email');
 perform public.mark_practice_sent(pid,'sg-msg-3');
 perform public.mark_practice_failed(pid,'bounce',true);
 if (select suppression_reason from public.user_contacts where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>'bounced' then raise exception 'Contact not suppressed'; end if;
 if (select count(*) from public.outbound_emails where kind='practice_paused')<>2 then raise exception 'Participant and sponsor not both told'; end if;
 if public.plan_practices()<>0 then raise exception 'Planned to a suppressed contact'; end if;
end $$;

-- One-click stop withdraws consent for that channel and cancels anything planned.
update public.user_contacts set suppressed_at=null, suppression_reason=null;
update public.user_practices set created_at=now()-interval '400 days', sent_at=coalesce(sent_at,now()-interval '400 days');
select public.plan_practices();
update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
update t set token=(select c.token from public.claim_due_practices('email') c);
do $$ declare pid uuid := (select id from public.user_practices where delivery_status='queued'); begin
 perform public.mark_practice_sent(pid,'sg-msg-4');
 -- Something else already planned to the same address.
 insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,channel,difficulty_at_send)
 values('22222222-2222-4222-8222-222222222222','e1111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()+interval '2 days','email',1);
end $$;
set local role anon;
do $$ begin if (public.stop_by_token((select token from t))->>'saved')::boolean is not true then raise exception 'Stop failed'; end if; end $$;
reset role;
do $$ begin
 if safekeep_private.has_grant('cccccccc-cccc-4ccc-8ccc-cccccccccccc','email') then raise exception 'Consent still granted after stop'; end if;
 if exists(select 1 from public.user_practices where delivery_status='scheduled') then raise exception 'Planned practice survived stop'; end if;
 if not exists(select 1 from public.practice_events where event_type='stop_received') then raise exception 'Stop not recorded'; end if;
end $$;

-- Observation windows close as "ignored it"; a version almost nobody is fooled by retires.
do $$ declare r jsonb; begin
 update public.user_practices set result='pending', observation_ends_at=now()-interval '1 minute' where delivery_status='sent' and result='pending';
 r := public.close_observations();
 if (r->>'closed')::int < 1 then raise exception 'Observation not closed: %', r; end if;
 if exists(select 1 from public.user_practices where delivery_status in ('sent','delivered') and result='pending' and observation_ends_at<now()) then raise exception 'Pending past its window'; end if;
end $$;

-- Editing a published version makes a new draft and keeps the old one live until the new one is approved.
create temp table nv(id uuid); grant all on nv to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
insert into nv select (public.admin_action('edit','{"version_id":"e1111111-1111-4111-8111-111111111111","subject":"Parcel on hold"}')->>'version_id')::uuid;
reset role;
do $$ begin if (select status from public.practice_scam_versions where id='e1111111-1111-4111-8111-111111111111')<>'published' then raise exception 'Old version pulled before approval'; end if; end $$;
set local role authenticated;
select public.admin_action('approve',jsonb_build_object('version_id',(select id from nv)));
reset role;
do $$ begin
 if (select status from public.practice_scam_versions where id='e1111111-1111-4111-8111-111111111111')<>'retired' then raise exception 'Old version not retired'; end if;
 if (select version_number from public.practice_scam_versions where id=(select id from nv))<>2 or (select subject from public.practice_scam_versions where id=(select id from nv))<>'Parcel on hold' then raise exception 'New version wrong'; end if;
end $$;
rollback;
select 'Practice tests passed; fixtures rolled back' as result;
