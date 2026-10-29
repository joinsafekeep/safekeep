-- Row-security and RPC tests for the Settings migration (database/settings.sql). Run in a transaction against a
-- database with base-schema.sql, account-onboarding.sql, signup-terms.sql and settings.sql applied; fixtures roll back.
begin;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('11111111-1111-4111-8111-111111111111','settings-a@example.invalid',now(),false),
('22222222-2222-4222-8222-222222222222','settings-b@example.invalid',now(),false);
insert into safekeep_private.secrets values('phone_verify_proof','test-secret') on conflict(name) do update set value='test-secret';
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.account_action('profile','{"first_name":"Synthetic A","timezone":"America/New_York","adult_confirmed":true}');
select public.account_action('sync_email');
select public.account_action('add_phone','{"kind":"mobile","phone":"+12125550123"}');
select public.account_action('add_phone','{"kind":"home","phone":"+12125550124"}');
do $$
declare uid uuid := auth.uid(); cell uuid; landline uuid; email_id uuid; proof text; rid uuid;
begin
 select id into cell from public.user_contacts where kind='mobile';
 select id into landline from public.user_contacts where kind='home';
 select id into email_id from public.user_contacts where kind='email';
 if (select verification_method from public.user_contacts where id=email_id)<>'auth_email' then raise exception 'Email verification method not recorded'; end if;
 -- Text consent needs a verified cell; nothing is verified yet.
 begin
  perform public.account_action('consent',jsonb_build_object('contact_id',cell,'channel','text','action','grant')); raise exception 'Unverified text consent allowed';
 exception when raise_exception then if sqlerrm='Unverified text consent allowed' then raise; end if; end;
 -- A guessed or missing proof is refused; the right proof verifies.
 begin
  perform public.account_action('verify_phone',jsonb_build_object('contact_id',cell,'method','otp_sms','proof','not-the-proof')); raise exception 'Bad proof accepted';
 exception when insufficient_privilege then null; end;
 proof := encode(extensions.hmac(convert_to(uid::text||':'||cell::text||':otp_sms','UTF8'),convert_to('test-secret','UTF8'),'sha256'),'hex');
 perform public.account_action('verify_phone',jsonb_build_object('contact_id',cell,'method','otp_sms','proof',proof));
 if (select verified_at from public.user_contacts where id=cell) is null or (select verification_method from public.user_contacts where id=cell)<>'otp_sms' then raise exception 'Phone not verified'; end if;
 -- A proof for the cell does not verify the landline, and a text grant needs a cell, not a landline.
 begin
  perform public.account_action('verify_phone',jsonb_build_object('contact_id',landline,'method','otp_sms','proof',proof)); raise exception 'Proof reused across contacts';
 exception when insufficient_privilege then null; end;
 proof := encode(extensions.hmac(convert_to(uid::text||':'||landline::text||':otp_call','UTF8'),convert_to('test-secret','UTF8'),'sha256'),'hex');
 perform public.account_action('verify_phone',jsonb_build_object('contact_id',landline,'method','otp_call','proof',proof));
 begin
  perform public.account_action('consent',jsonb_build_object('contact_id',landline,'channel','text','action','grant')); raise exception 'Text consent on a landline allowed';
 exception when raise_exception then if sqlerrm='Text consent on a landline allowed' then raise; end if; end;
 -- Per-channel consent on verified numbers.
 perform public.account_action('consent',jsonb_build_object('contact_id',cell,'channel','text','action','grant'));
 perform public.account_action('consent',jsonb_build_object('contact_id',landline,'channel','phone','action','grant'));
 if (select count(*) from public.consent_events where action='grant')<>2 then raise exception 'Channel grants not recorded'; end if;
 -- Practices can be enabled on a text grant alone; caps, pause and alerts opt-in are saved; a far pause is refused.
 perform public.account_action('preferences',jsonb_build_object('practice_enabled',true,'max_practices_per_week',2,'quiet_hours_start','20:00','quiet_hours_end','09:00','email_cap_per_month',4,'text_cap_per_month',3,'call_cap_per_month',1,'paused_until',(current_date+14)::text,'alerts_opt_in',true));
 if (select text_cap_per_month from public.user_preferences)<>3 or (select paused_until from public.user_preferences)<>current_date+14 or not (select alerts_opt_in from public.user_preferences) then raise exception 'Preferences not saved'; end if;
 begin
  perform public.account_action('preferences',jsonb_build_object('practice_enabled',true,'max_practices_per_week',2,'quiet_hours_start','20:00','quiet_hours_end','09:00','paused_until',(current_date+400)::text)); raise exception 'Far pause accepted';
 exception when raise_exception then if sqlerrm='Far pause accepted' then raise; end if; end;
 -- Removing a number withdraws its consent and suppresses it; it can no longer be granted.
 perform public.account_action('remove_phone',jsonb_build_object('contact_id',cell));
 if (select action from public.consent_events where contact_id=cell order by sequence desc limit 1)<>'revoke' then raise exception 'Removal did not revoke'; end if;
 if (select suppressed_at from public.user_contacts where id=cell) is null then raise exception 'Removal did not suppress'; end if;
 begin
  perform public.account_action('consent',jsonb_build_object('contact_id',cell,'channel','text','action','grant')); raise exception 'Grant on a removed number allowed';
 exception when raise_exception then if sqlerrm='Grant on a removed number allowed' then raise; end if; end;
 -- Report recipients: add, duplicate refused, cap of five, remove.
 perform public.account_action('add_report_recipient','{"name":"Daughter","email":"Daughter@Example.invalid"}');
 begin
  perform public.account_action('add_report_recipient','{"name":"Again","email":"daughter@example.invalid"}'); raise exception 'Duplicate recipient accepted';
 exception when raise_exception then if sqlerrm='Duplicate recipient accepted' then raise; end if; end;
 for i in 2..5 loop perform public.account_action('add_report_recipient',jsonb_build_object('name','Person '||i,'email','person'||i||'@example.invalid')); end loop;
 begin
  perform public.account_action('add_report_recipient','{"name":"Six","email":"six@example.invalid"}'); raise exception 'Sixth recipient accepted';
 exception when raise_exception then if sqlerrm='Sixth recipient accepted' then raise; end if; end;
 select id into rid from public.report_recipients where email='daughter@example.invalid';
 perform public.account_action('remove_report_recipient',jsonb_build_object('recipient_id',rid));
 if (select count(*) from public.report_recipients where removed_at is null)<>4 then raise exception 'Recipient not removed'; end if;
 begin
  update public.report_recipients set removed_at=null; raise exception 'Direct recipient write allowed';
 exception when insufficient_privilege then null; end;
 -- Deletion: withdraws every grant, stops practice, clears recipients; cancelling keeps the account.
 perform public.account_action('request_deletion');
 if (select practice_enabled from public.user_preferences) then raise exception 'Deletion left practice on'; end if;
 if (select action from public.consent_events where contact_id=landline order by sequence desc limit 1)<>'revoke' then raise exception 'Deletion did not revoke'; end if;
 if exists(select 1 from public.report_recipients where removed_at is null) then raise exception 'Deletion left recipients'; end if;
 begin
  perform public.account_action('consent',jsonb_build_object('contact_id',landline,'channel','phone','action','grant')); raise exception 'Grant during pending deletion allowed';
 exception when raise_exception then if sqlerrm='Grant during pending deletion allowed' then raise; end if; end;
 perform public.account_action('cancel_deletion');
 if (select cancelled_at from public.account_deletions where user_id=uid) is null then raise exception 'Deletion not cancelled'; end if;
 perform public.account_action('consent',jsonb_build_object('contact_id',landline,'channel','phone','action','grant'));
end $$;
-- Another user sees none of it and cannot act on it.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
 if exists(select 1 from public.report_recipients) or exists(select 1 from public.account_deletions) or exists(select 1 from public.user_contacts) then raise exception 'Cross-user read leak'; end if;
 begin
  perform public.account_action('remove_report_recipient','{"recipient_id":"44444444-4444-4444-8444-444444444444"}'); raise exception 'Foreign recipient removal accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.account_action('cancel_deletion'); raise exception 'Foreign cancel accepted';
 exception when raise_exception then if sqlerrm='Foreign cancel accepted' then raise; end if; end;
 begin
  perform (select value from safekeep_private.secrets limit 1); raise exception 'Secrets readable';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'Settings tests passed; fixtures rolled back' as result;
