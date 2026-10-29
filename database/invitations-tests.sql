-- Tests for database/invitations.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into safekeep_private.secrets values('app_origin','https://joinsafekeep.com') on conflict(name) do update set value=excluded.value;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','sponsor@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','mom@example.invalid',now(),false),
('33333333-3333-4333-8333-333333333333','someone-else@example.invalid',now(),false),
('44444444-4444-4444-8444-444444444444','dad@example.invalid',now(),false);
insert into public.user_profiles(user_id,first_name,timezone,adult_confirmed_at) values
('11111111-1111-4111-8111-111111111111','Ian','America/New_York',now()),('22222222-2222-4222-8222-222222222222','Margaret','America/Chicago',now());
-- A Pairs plan: two participant seats.
insert into public.subscriptions(id,sponsor_user_id,stripe_customer_id,stripe_subscription_id,plan,billing,seats,status)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cus_t','sub_t','pairs','annual',2,'active');
insert into public.subscription_members(subscription_id,user_id,role) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','sponsor');
set local role authenticated;

-- The sponsor invites Mom: one row, one email whose link carries the token; the token itself is never readable.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.invitation_action('invite','{"invitee_name":"Mom","invitee_email":"Mom@Example.invalid","invitee_phone":"212-555-1234","personal_note":"Love you. Try it?"}');
do $$ begin
 if (select count(*) from public.participant_invitations)<>1 then raise exception 'Sponsor cannot see the invitation'; end if;
 begin perform (select token_hash from public.participant_invitations limit 1); raise exception 'Token hash readable'; exception when insufficient_privilege then null; end;
 begin perform public.invitation_action('invite','{"invitee_name":"Mom again","invitee_email":"mom@example.invalid"}'); raise exception 'Duplicate invite allowed'; exception when raise_exception then if sqlerrm='Duplicate invite allowed' then raise; end if; end;
 begin perform public.invitation_action('invite','{"invitee_name":"Me","invitee_email":"sponsor@example.invalid"}'); raise exception 'Self-invite allowed'; exception when raise_exception then if sqlerrm='Self-invite allowed' then raise; end if; end;
end $$;
reset role;
create temp table t(token text, old_token text);
grant all on t to authenticated, anon;
insert into t(token) select substring(body from '/invite/\?t=([0-9a-f]{64})') from public.outbound_emails where kind='invitation' and to_email='mom@example.invalid';
do $$ begin
 if (select token from t) is null then raise exception 'Invite email has no link'; end if;
 if (select body from public.outbound_emails where kind='invitation') not like '%Ian has given you a Safekeep plan%' or (select body from public.outbound_emails where kind='invitation') not like '%They wrote: "Love you. Try it?"%' then raise exception 'Invite email wording'; end if;
 if (select body from public.outbound_emails where kind='invitation') not like '%https://joinsafekeep.com/invite/?t=%' then raise exception 'Invite link origin'; end if;
end $$;

-- Before signing in, the page can show the invitation by token; a wrong token shows nothing.
set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 if (select sponsor_name from public.invitation_by_token((select token from t)))<>'Ian' then raise exception 'Invitation lookup failed'; end if;
 if (select invitee_email from public.invitation_by_token((select token from t)))<>'mom@example.invalid' then raise exception 'Invitation email not lowercased'; end if;
 if exists(select 1 from public.invitation_by_token(repeat('0',64))) then raise exception 'Wrong token matched'; end if;
 begin perform public.invitation_action('accept',jsonb_build_object('token',(select token from t))); raise exception 'Anonymous accept'; exception when insufficient_privilege then null; end;
end $$;

-- Knowing the token is not enough: the sponsor, or anyone else signed in, cannot accept for Mom.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 begin perform public.invitation_action('accept',jsonb_build_object('token',(select token from t))); raise exception 'Sponsor accepted for Mom'; exception when raise_exception then if sqlerrm='Sponsor accepted for Mom' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$ begin
 begin perform public.invitation_action('accept',jsonb_build_object('token',(select token from t))); raise exception 'Stranger accepted'; exception when raise_exception then if sqlerrm='Stranger accepted' then raise; end if; end;
 if exists(select 1 from public.participant_invitations) then raise exception 'Stranger sees invitation'; end if;
end $$;

-- Resend rotates the token: the old link stops working.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.invitation_action('resend',jsonb_build_object('invitation_id',(select id from public.participant_invitations)));
reset role;
update t set old_token=token, token=(select substring(e.body from '/invite/\?t=([0-9a-f]{64})') from public.outbound_emails e where e.kind='invitation' and e.to_email='mom@example.invalid' and e.body not like '%'||t.token||'%' limit 1);
do $$ begin
 if (select token from t)=(select old_token from t) then raise exception 'Token not rotated'; end if;
 if exists(select 1 from public.invitation_by_token((select old_token from t))) then raise exception 'Old token still valid'; end if;
end $$;

-- Seats: Mom's pending invite plus one more fills a Pairs plan; a third is refused.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.invitation_action('invite','{"invitee_name":"Dad","invitee_email":"dad@example.invalid"}');
do $$ begin
 begin perform public.invitation_action('invite','{"invitee_name":"Aunt","invitee_email":"aunt@example.invalid"}'); raise exception 'Seat overbooked'; exception when raise_exception then if sqlerrm='Seat overbooked' then raise; end if; end;
 begin perform public.invitation_action('join_own_plan'); raise exception 'Joined a full plan'; exception when raise_exception then if sqlerrm='Joined a full plan' then raise; end if; end;
 if (select count(*) from public.sponsor_seats() where kind='invitation')<>2 then raise exception 'Sponsor seats wrong'; end if;
end $$;

-- Dad says no thanks without an account: seat freed, sponsor told; saying it twice is harmless.
reset role;
insert into t(token) select substring(body from '/invite/\?t=([0-9a-f]{64})') from public.outbound_emails where to_email='dad@example.invalid';
set local role anon;
do $$ declare dad text := (select token from t where token is not null and old_token is null and token<>(select token from t where old_token is not null)); begin
 if (public.decline_invitation(dad)->>'saved')::boolean is not true then raise exception 'Decline failed'; end if;
 if (public.decline_invitation(dad)->>'saved')::boolean then raise exception 'Declined twice'; end if;
end $$;
reset role;
do $$ begin
 if (select count(*) from public.outbound_emails where kind='invitation_declined' and to_email='sponsor@example.invalid')<>1 then raise exception 'Sponsor not told of decline'; end if;
end $$;

-- Mom, signed in with the invited address, accepts: she takes the seat, the sponsor is told, and it is idempotent.
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select public.invitation_action('accept',jsonb_build_object('token',(select token from t where old_token is not null)));
select public.invitation_action('accept',jsonb_build_object('token',(select token from t where old_token is not null)));
do $$ begin
 if public.is_active_participant('22222222-2222-4222-8222-222222222222') is not true then raise exception 'Mom not active after accepting'; end if;
 if (select sponsor_name from public.my_sponsorship())<>'Ian' then raise exception 'Mom cannot see whose plan she is on'; end if;
end $$;
reset role;
do $$ begin
 if (select count(*) from public.outbound_emails where kind='invitation_accepted')<>1 then raise exception 'Accept email count'; end if;
 if (select subject from public.outbound_emails where kind='invitation_accepted') not like 'Margaret accepted%' then raise exception 'Accept email uses profile name'; end if;
end $$;
-- Mom turns on email practice; the sponsor sees the channel name, not the address.
insert into public.user_contacts(id,user_id,kind,normalized_value,verified_at) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222','email','mom@example.invalid',now());
insert into public.consent_events(user_id,contact_id,channel,action,policy_version,source) values('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','email','grant','v','test');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
 if (select channels from public.sponsor_seats() where kind='participant')<>array['email'] then raise exception 'Sponsor does not see channel names'; end if;
 if (select email from public.sponsor_seats() where kind='participant') is not null then raise exception 'Sponsor sees participant email'; end if;
 if exists(select 1 from public.user_contacts) then raise exception 'Sponsor reads participant contacts'; end if;
 -- With Dad's seat freed, the sponsor can practise on their own plan.
 perform public.invitation_action('join_own_plan');
 if public.is_active_participant('11111111-1111-4111-8111-111111111111') is not true then raise exception 'Sponsor could not join own plan'; end if;
 if exists(select 1 from public.my_sponsorship()) then raise exception 'Own plan shown as someone else''s'; end if;
end $$;

-- Removing Mom stops her practice and tells her; her account stays.
select public.invitation_action('remove_participant',jsonb_build_object('member_id',(select id from public.sponsor_seats() where kind='participant' and name='Margaret')));
reset role;
do $$ begin
 if (select status from public.subscription_members where user_id='22222222-2222-4222-8222-222222222222')<>'removed' then raise exception 'Mom not removed'; end if;
 if (select count(*) from public.outbound_emails where kind='participant_removed' and to_email='mom@example.invalid')<>1 then raise exception 'Mom not told'; end if;
end $$;

-- A pending invitation is revoked when the plan ends.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.invitation_action('invite','{"invitee_name":"Aunt","invitee_email":"aunt@example.invalid"}');
reset role;
select set_config('request.jwt.claim.sub','',true);
select public.end_subscription('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
do $$ begin
 if exists(select 1 from public.participant_invitations where accepted_at is null and declined_at is null and revoked_at is null) then raise exception 'Pending invitation survived the end of the plan'; end if;
 if (select count(*) from public.outbound_emails where kind='subscription_ended' and to_email='sponsor@example.invalid')<>1 then raise exception 'Sponsor end email'; end if;
end $$;
rollback;
select 'Invitation tests passed; fixtures rolled back' as result;
