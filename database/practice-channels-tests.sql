-- Tests for database/practice-channels.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into safekeep_private.secrets values('app_origin','https://joinsafekeep.com') on conflict(name) do update set value=excluded.value;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','sponsor@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','mom@example.invalid',now(),false),
('99999999-9999-4999-8999-999999999999','ian@example.invalid',now(),false);
insert into public.user_profiles(user_id,first_name,timezone,adult_confirmed_at) values('22222222-2222-4222-8222-222222222222','Margaret','America/Chicago',now());
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,plan,billing,seats,status)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_t','sub_t','pairs','annual',2,'active');
insert into public.subscription_members(subscription_id,user_id,role) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','participant');
insert into public.user_contacts(id,user_id,kind,normalized_value,verified_at) values
('c1111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','mobile','+15555550101',now()),
('c2222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','home','+15555550102',now());
insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values
('22222222-2222-4222-8222-222222222222','c1111111-1111-4111-8111-111111111111','text','grant','v','test'),
('22222222-2222-4222-8222-222222222222','c2222222-2222-4222-8222-222222222222','phone','grant','v','test');
insert into public.user_preferences(user_id,practice_enabled,max_practices_per_week,call_cap_per_month,text_cap_per_month,quiet_hours_start,quiet_hours_end)
values('22222222-2222-4222-8222-222222222222',true,7,7,7,((now() at time zone 'America/Chicago') + interval '3 hours')::time,((now() at time zone 'America/Chicago') - interval '3 hours')::time);
insert into public.admin_users(user_id) values('99999999-9999-4999-8999-999999999999');
insert into public.practice_scams(id,stable_code,name,category) values('d1111111-1111-4111-8111-111111111111','test-family','"It''s me"','family_emergency'),('d2222222-2222-4222-8222-222222222222','test-bank','Bank call','bank');
insert into public.practice_scam_versions(id,scam_id,version_number,format,difficulty,content,learning_objective,debrief,status,tells,channel_variant,next_steps) values
('e1111111-1111-4111-8111-111111111111','d1111111-1111-4111-8111-111111111111',1,'text',1,'Hi it''s me, reply YES','x','y','published','[{"quote":"Hi it''s me","note":"No name."}]','{"reply_keywords":["yes"]}','{"Call them back."}'),
('e2222222-2222-4222-8222-222222222222','d2222222-2222-4222-8222-222222222222',1,'phone',1,'Opening\n\nPress 1\n\nPressure','x','y','published','[{"quote":"Opening","note":"No bank name."}]','{"script":{"opening":"Opening","hook":"Press 1","pressure":"Pressure"}}','{"Hang up and call the bank."}');
select set_config('request.jwt.claim.sub','',true);

-- Only channels that are sending get planned, and anything planned on a switched-off channel is cancelled.
do $$ begin
 if public.plan_practices(array['email'])<>0 then raise exception 'Planned with no email contact'; end if;
 if public.plan_practices(array['text'])<>1 or (select channel from public.user_practices)<>'text' then raise exception 'Text not planned'; end if;
 if public.cancel_planned_outside(array['email'])<>1 then raise exception 'Switched-off channel not cancelled'; end if;
end $$;
delete from public.user_practices;

-- A practice text, then a reply: a practice opportunity, with a fresh coaching link that opens the page.
select public.plan_practices(array['text']);
update public.user_practices set scheduled_at=now()-interval '1 minute';
create temp table t(token text); grant all on t to anon;
do $$ declare pid uuid; r jsonb; begin
 select practice_id into pid from public.claim_due_practices('text');
 perform public.mark_practice_sent(pid,'SM1');
 if (select practice_id from public.practice_for_text_reply('+15555550101'))<>pid then raise exception 'Reply not matched to practice'; end if;
 if exists(select 1 from public.practice_for_text_reply('+15555559999')) then raise exception 'Matched a stranger'; end if;
 r := public.record_text_reply(pid,'reply','SMr1','YES');
 if r->>'result'<>'engaged' then raise exception 'Reply not a practice opportunity'; end if;
 insert into t values(r->>'token');
end $$;
set local role anon;
do $$ begin if (public.coaching_view((select token from t))->>'name') is null then raise exception 'Reply link does not open coaching'; end if; end $$;
reset role;

-- Worried replies: inconclusive, distress event, and every admin is emailed with the reply.
do $$ declare pid uuid := (select id from public.user_practices where channel='text'); begin
 perform public.record_text_reply(pid,'distress','SMr2','who is this?? I am scared');
 if (select result from public.user_practices where id=pid)<>'inconclusive' then raise exception 'Distress not inconclusive'; end if;
 if not exists(select 1 from public.practice_events where user_practice_id=pid and event_type='distress_flagged') then raise exception 'Distress not recorded'; end if;
 if (select count(*) from public.outbound_emails where kind='distress_alert' and to_email='ian@example.invalid' and body like '%I am scared%' and body like '%Margaret%')<>1 then raise exception 'Admin not emailed'; end if;
 -- The same Twilio message twice records once.
 perform public.record_text_reply(pid,'distress','SMr2','who is this?? I am scared');
 if (select count(*) from public.practice_events where provider_event_id='SMr2')<>1 or (select count(*) from public.outbound_emails where kind='distress_alert')<>1 then raise exception 'Duplicate webhook recorded twice'; end if;
end $$;

-- STOP from the number: consent withdrawn, anything planned cancelled, never counted as engagement.
do $$ begin
 insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at,channel,difficulty_at_send)
 values('22222222-2222-4222-8222-222222222222','e1111111-1111-4111-8111-111111111111','c1111111-1111-4111-8111-111111111111',now()+interval '2 days','text',1);
 if public.stop_texts_from('+15555550101')<>1 then raise exception 'Stop did not revoke'; end if;
 if safekeep_private.has_grant('c1111111-1111-4111-8111-111111111111','text') then raise exception 'Still granted'; end if;
 if exists(select 1 from public.user_practices where delivery_status='scheduled') then raise exception 'Planned text survived STOP'; end if;
end $$;

-- A practice call: answered, hook taken, revealed in the call; no follow-up email needed.
do $$ declare pid uuid; s jsonb; begin
 update public.user_practices set created_at=now()-interval '400 days', sent_at=now()-interval '400 days' where sent_at is not null;
 perform public.plan_practices(array['phone']);
 update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
 select practice_id into pid from public.claim_due_practices('phone');
 if pid is null then raise exception 'No call claimed'; end if;
 perform public.mark_practice_sent(pid,'CA1');
 s := public.call_script(pid);
 if s->'script'->>'hook'<>'Press 1' then raise exception 'Script missing'; end if;
 if (s->>'can_text')::boolean then raise exception 'Offered a text after STOP'; end if;
 perform public.record_call_event(pid,'answered');
 perform public.record_call_event(pid,'hook');
 perform public.record_call_event(pid,'revealed');
 perform public.record_call_event(pid,'ended','CA1',62,'human');
 if (select result from public.user_practices where id=pid)<>'engaged' or (select delivery_status from public.user_practices where id=pid)<>'delivered' then raise exception 'Call outcome wrong'; end if;
 if exists(select 1 from public.outbound_emails where kind='practice_reveal') then raise exception 'Reveal emailed after an in-call reveal'; end if;
end $$;

-- Answered and hung up before the hook: spotted it, and an email reveals it with a working coaching link.
do $$ declare pid uuid; begin
 update public.user_practices set created_at=now()-interval '400 days', sent_at=now()-interval '400 days' where sent_at is not null;
 perform public.plan_practices(array['phone']);
 update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
 select practice_id into pid from public.claim_due_practices('phone');
 perform public.mark_practice_sent(pid,'CA2');
 perform public.record_call_event(pid,'answered');
 perform public.record_call_event(pid,'ended','CA2',14,'human');
 if (select result from public.user_practices where id=pid)<>'declined' then raise exception 'Hang-up not counted as spotted'; end if;
 if (select count(*) from public.outbound_emails where kind='practice_reveal' and to_email='mom@example.invalid' and body like '%You hung up, which was exactly the right thing to do.%')<>1 then raise exception 'No reveal email'; end if;
 delete from t; insert into t select substring(body from '/p/([0-9a-f]{48})') from public.outbound_emails where kind='practice_reveal';
end $$;
set local role anon;
do $$ begin if (public.coaching_view((select token from t))->>'result')<>'declined' then raise exception 'Reveal link does not open coaching'; end if; end $$;
reset role;

-- Three unanswered calls in a row pause calls to that number and tell her.
do $$ declare pid uuid; i int; begin
 for i in 1..3 loop
  -- Shift everything already sent back a day, keeping the order, so the newest three are these calls.
  update public.user_practices set created_at=now()-interval '400 days', sent_at=sent_at-interval '1 day' where sent_at is not null;
  perform public.plan_practices(array['phone']);
  update public.user_practices set scheduled_at=now()-interval '1 minute' where delivery_status='scheduled';
  select practice_id into pid from public.claim_due_practices('phone');
  perform public.mark_practice_sent(pid,'CAu'||i);
  perform public.record_call_event(pid,'ended','CAu'||i,null,null);
 end loop;
 if (select suppression_reason from public.user_contacts where id='c2222222-2222-4222-8222-222222222222')<>'bounced' then raise exception 'Three unanswered calls did not pause calls'; end if;
 if not exists(select 1 from public.outbound_emails where kind='practice_paused' and to_email='mom@example.invalid' and subject like '%phone calls%') then raise exception 'Participant not told'; end if;
 if exists(select 1 from public.outbound_emails where kind='practice_reveal' and body like '%CAu%') then raise exception 'Reveal sent for unanswered call'; end if;
end $$;

-- Pressing 9 stops practice calls.
update public.user_contacts set suppressed_at=null, suppression_reason=null;
do $$ declare pid uuid := (select id from public.user_practices where channel='phone' order by sent_at desc limit 1); begin
 perform public.record_call_event(pid,'stop');
 if safekeep_private.has_grant('c2222222-2222-4222-8222-222222222222','phone') then raise exception 'Press 9 did not stop calls'; end if;
end $$;

-- None of this is reachable by a signed-in user.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 begin perform public.stop_texts_from('+15555550101'); raise exception 'Participant called stop_texts_from'; exception when insufficient_privilege then null; end;
 begin perform public.record_text_reply(gen_random_uuid(),'report','x','y'); raise exception 'Participant called record_text_reply'; exception when insufficient_privilege then null; end;
 begin perform public.call_script(gen_random_uuid()); raise exception 'Participant read a call script'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'Text and phone practice tests passed; fixtures rolled back' as result;
