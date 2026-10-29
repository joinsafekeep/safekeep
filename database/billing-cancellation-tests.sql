-- Tests for database/billing-cancellation.sql. Run in a transaction against a database with all migrations applied;
-- fixtures roll back. Covers read scoping, the entitlement check, ending a subscription, and a participant leaving.
begin;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','sponsor@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','participant@example.invalid',now(),false),
('33333333-3333-4333-8333-333333333333','stranger@example.invalid',now(),false);
insert into public.user_profiles(user_id,first_name,timezone,adult_confirmed_at) values('22222222-2222-4222-8222-222222222222','Mom','America/New_York',now());
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,price_id,plan,billing,seats,status,current_period_end)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_test','sub_test','price_family_annual','family','annual',4,'active',now()+interval '300 days');
insert into public.subscription_members(subscription_id,user_id,role) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','sponsor'),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','participant');
-- A queued practice for the participant, to be cancelled when they leave or the plan ends.
insert into public.user_contacts(id,user_id,kind,normalized_value,verified_at) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222','email','participant@example.invalid',now());
insert into public.practice_scams(id,stable_code,name,category) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','test-1','Test','test');
insert into public.practice_scam_versions(id,scam_id,version_number,format,difficulty,content,learning_objective,debrief,status) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'email',1,'x','x','x','published');
insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at) values('22222222-2222-4222-8222-222222222222','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()+interval '1 day');

set local role authenticated;
-- The sponsor sees the subscription and both seats; the participant sees the subscription and their own seat.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 if (select count(*) from public.subscriptions)<>1 or (select count(*) from public.subscription_members)<>2 then raise exception 'Sponsor cannot read their plan'; end if;
 if public.is_active_participant('11111111-1111-4111-8111-111111111111') is not true then raise exception 'Sponsor seat not active'; end if;
 begin perform public.is_active_participant('22222222-2222-4222-8222-222222222222'); raise exception 'Checked someone else'; exception when insufficient_privilege then null; end;
 begin perform public.account_action('leave_subscription'); raise exception 'Sponsor left their own plan'; exception when raise_exception then if sqlerrm='Sponsor left their own plan' then raise; end if; end;
 begin perform public.end_subscription('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); raise exception 'User ended a subscription'; exception when insufficient_privilege then null; end;
 begin update public.subscriptions set status='canceled'; raise exception 'Direct subscription write allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 if (select count(*) from public.subscriptions)<>1 or (select count(*) from public.subscription_members)<>1 then raise exception 'Participant read scope wrong'; end if;
 if public.is_active_participant('22222222-2222-4222-8222-222222222222') is not true then raise exception 'Participant seat not active'; end if;
 begin perform (select 1 from public.outbound_emails limit 1); raise exception 'Emails readable'; exception when insufficient_privilege then null; end;
end $$;
-- A stranger sees nothing.
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$ begin
 if exists(select 1 from public.subscriptions) or exists(select 1 from public.subscription_members) then raise exception 'Cross-user read leak'; end if;
 if public.is_active_participant('33333333-3333-4333-8333-333333333333') then raise exception 'Stranger active'; end if;
end $$;
-- The participant leaves: seat freed, queue cancelled, sponsor emailed.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select public.account_action('leave_subscription');
reset role;
select set_config('request.jwt.claim.sub','',true); -- the service role has no user claim
do $$ begin
 if (select status from public.subscription_members where user_id='22222222-2222-4222-8222-222222222222')<>'left' then raise exception 'Seat not freed'; end if;
 if (select delivery_status from public.user_practices where user_id='22222222-2222-4222-8222-222222222222')<>'cancelled' then raise exception 'Queue not cancelled on leave'; end if;
 if (select count(*) from public.outbound_emails where kind='participant_left' and to_email='sponsor@example.invalid' and subject like 'Mom has left%')<>1 then raise exception 'Sponsor not told'; end if;
 if public.is_active_participant('22222222-2222-4222-8222-222222222222') then raise exception 'Left participant still active'; end if;
end $$;
-- Put the participant back, then end the plan the way the webhook does: everyone inactive, two emails.
update public.subscription_members set status='active', ended_at=null where user_id='22222222-2222-4222-8222-222222222222';
insert into public.user_practices(user_id,scam_version_id,destination_contact_id,scheduled_at) values('22222222-2222-4222-8222-222222222222','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()+interval '2 days');
select public.end_subscription('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now());
do $$ begin
 if (select count(*) from public.subscription_members where status='ended')<>2 then raise exception 'Seats not ended'; end if;
 if exists(select 1 from public.user_practices where delivery_status in ('scheduled','queued')) then raise exception 'Queue not cancelled on end'; end if;
 if (select count(*) from public.outbound_emails where kind='subscription_ended')<>2 then raise exception 'Ending emails not queued'; end if;
 if (select count(*) from public.outbound_emails where to_email='participant@example.invalid' and kind='subscription_ended')<>1 then raise exception 'Participant not told'; end if;
 if (select ended_at from public.subscriptions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') is null then raise exception 'ended_at not set'; end if;
 if public.is_active_participant('11111111-1111-4111-8111-111111111111') then raise exception 'Sponsor still active after end'; end if;
end $$;
-- Dunning grace: past due keeps a seat active for seven days, then not.
update public.subscriptions set status='past_due', past_due_since=now()-interval '3 days';
update public.subscription_members set status='active' where user_id='11111111-1111-4111-8111-111111111111';
do $$ begin
 if not public.is_active_participant('11111111-1111-4111-8111-111111111111') then raise exception 'Grace period not honoured'; end if;
 update public.subscriptions set past_due_since=now()-interval '8 days';
 if public.is_active_participant('11111111-1111-4111-8111-111111111111') then raise exception 'Grace period not enforced'; end if;
end $$;
rollback;
select 'Cancellation tests passed; fixtures rolled back' as result;
