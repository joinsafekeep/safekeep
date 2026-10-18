begin;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','account-a@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','account-b@example.invalid',now(),false),
('33333333-3333-4333-8333-333333333333','unverified@example.invalid',null,false);
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.account_action('profile','{"first_name":"Synthetic A","timezone":"America/New_York","adult_confirmed":true}');
select public.account_action('sync_email');
select public.account_action('add_phone','{"kind":"mobile","phone":"+12125550123"}');
do $$
declare email_id uuid; foreign_id uuid;
begin
 if (select count(*) from public.user_profiles)<>1 then raise exception 'Profile isolation failed'; end if;
 if exists(select 1 from public.user_contacts where kind='mobile' and verified_at is not null) then raise exception 'Phone auto-verified'; end if;
 begin
  perform public.account_action('preferences','{"practice_enabled":true,"max_practices_per_week":1,"quiet_hours_start":"20:00","quiet_hours_end":"09:00"}');
  raise exception 'Enabled practices without consent';
 exception when raise_exception then if sqlerrm='Enabled practices without consent' then raise; end if; end;
 select id into email_id from public.user_contacts where kind='email';
 perform public.account_action('consent',jsonb_build_object('contact_id',email_id,'channel','email','action','grant','user_id','22222222-2222-4222-8222-222222222222'));
 if exists(select 1 from public.consent_events where user_id<>auth.uid()) then raise exception 'Spoofed user'; end if;
 perform public.account_action('preferences','{"practice_enabled":true,"max_practices_per_week":1,"quiet_hours_start":"20:00","quiet_hours_end":"09:00"}');
 if not (select practice_enabled from public.user_preferences) then raise exception 'Preferences not saved'; end if;
 perform public.account_action('consent',jsonb_build_object('contact_id',email_id,'channel','email','action','revoke'));
 if (select action from public.consent_events order by sequence desc limit 1)<>'revoke' then raise exception 'Consent withdrawal failed'; end if;
 begin
  update public.user_contacts set verified_at=now(); raise exception 'Self verification allowed';
 exception when insufficient_privilege then null; end;
 begin
  update public.user_preferences set practice_enabled=true; raise exception 'Direct consent bypass';
 exception when insufficient_privilege then null; end;
 begin
  perform public.account_action('consent',jsonb_build_object('contact_id',email_id,'channel','text','action','grant'));raise exception 'Phone consent allowed';
 exception when raise_exception then if sqlerrm='Phone consent allowed' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 if exists(select 1 from public.user_profiles) or exists(select 1 from public.user_contacts) or exists(select 1 from public.consent_events) then raise exception 'Cross-user read leak'; end if;
 begin
  perform public.account_action('consent','{"contact_id":"44444444-4444-4444-8444-444444444444","channel":"email","action":"grant"}');raise exception 'Foreign consent accepted';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$ begin
 begin perform public.account_action('sync_email'); raise exception 'Unverified account accepted'; exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
 begin perform public.account_action('sync_email');raise exception 'Anonymous action allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
select 'Account/consent tests passed; fixtures rolled back' as result;
