import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler,checkPassword} from '../netlify/functions/account.mjs';
const origin='https://joinsafekeep.com';
const request=(body,customOrigin=origin)=>new Request(origin+'/api/account',body?{method:'POST',headers:{origin:customOrigin,'content-type':'application/json'},body:JSON.stringify(body)}:{});
function setup(overrides={}) {
 const calls=[];
 const client={auth:{getUser:async()=>({data:{user:{id:'user-a',email:'a@example.com',email_confirmed_at:'2026-01-01'}}}),...overrides},rpc:async(name,args)=>{calls.push({name,args});return {data:{saved:true},error:null};}};
 let options;
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:(_url,_key,opts)=>{options=opts;return client;}});
 return {handler,calls,get options(){return options;}};
}
// A chainable stand-in for supabase-js queries: every filter returns the builder, terminal calls resolve rows per table.
function fakeFrom(rows={}){return table=>{const data=rows[table]||[];const b={};for(const m of ['select','eq','is','order'])b[m]=()=>b;b.maybeSingle=async()=>({data:data[0]||null,error:null});b.then=(ok)=>ok({data,error:null});return b;};}
test('password policy enforces bounds without trimming passwords',()=>{
 assert.throws(()=>checkPassword('short'));assert.throws(()=>checkPassword('a'.repeat(129)));assert.equal(checkPassword('a'.repeat(12)),'a'.repeat(12));
});
test('cross-origin and missing-origin writes are rejected before authentication',async()=>{
 const s=setup();assert.equal((await s.handler(request({action:'login'},'https://evil.example'))).status,403);assert.equal(s.options,undefined);
 const req=new Request(origin+'/api/account',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal((await s.handler(req)).status,403);
});
test('unverified accounts cannot access profiles or perform account actions',async()=>{
 const s=setup({getUser:async()=>({data:{user:{id:'a',email_confirmed_at:null}}})});
 assert.equal((await s.handler(request({action:'profile',payload:{first_name:'A'}}))).status,401);assert.equal(s.calls.length,0);
});
test('verified requests use database account action without trusting a supplied user ID',async()=>{
 const s=setup();const result=await s.handler(request({action:'consent',payload:{user_id:'victim',action:'grant',channel:'email',contact_id:'contact'}}));
 assert.equal(result.status,200);assert.equal(s.calls[0].name,'account_action');assert.equal(s.calls[0].args.action,'consent');
 assert.equal(s.options.cookieOptions.httpOnly,true);assert.equal(s.options.cookieOptions.secure,true);assert.equal(s.options.cookieOptions.sameSite,'lax');assert.equal(result.headers.get('cache-control'),'private, no-store');
});
test('login never returns session tokens in JSON and sets secure cookie options',async()=>{
 const s=setup({signInWithPassword:async()=>({data:{user:{id:'user-a',email_confirmed_at:'yes'},session:{access_token:'DO_NOT_EXPOSE'}}})});
 const response=await s.handler(request({action:'login',email:'a@example.com',password:'secret'}));assert.equal(response.status,200);assert.ok(!(await response.text()).includes('DO_NOT_EXPOSE'));
});
test('password change requires current-password reauthentication',async()=>{
 let updated=false;const s=setup({signInWithPassword:async()=>({error:{message:'bad'}}),updateUser:async()=>{updated=true;}});
 assert.equal((await s.handler(request({action:'password',current_password:'bad',new_password:'long enough password'}))).status,401);assert.equal(updated,false);
});
test('recovery confirmation changes password only for a recovery exchange',async()=>{
 let updated=false;
 const s=setup({exchangeCodeForSession:async()=>({data:{user:{email_confirmed_at:'yes'},redirectType:null}}),signOut:async()=>({}),updateUser:async()=>{updated=true;}});
 assert.equal((await s.handler(request({action:'confirm',code:'code',new_password:'long enough password'}))).status,400);assert.equal(updated,false);
});
test('successful password recovery revokes sessions after updating',async()=>{
 const order=[];const s=setup({exchangeCodeForSession:async()=>({data:{user:{email_confirmed_at:'yes'},redirectType:'recovery'}}),updateUser:async()=>{order.push('update');return {data:{}};},signOut:async({scope})=>{order.push(scope);return {data:{}};}});
 assert.equal((await s.handler(request({action:'confirm',code:'code',new_password:'long enough password'}))).status,200);assert.deepEqual(order,['update','global']);
});
test('reset requests hide account existence and provider errors',async()=>{
 const s=setup({resetPasswordForEmail:async()=>({error:{message:'not found'}})});const r=await s.handler(request({action:'recover',email:'nobody@example.com'}));assert.equal(r.status,200);assert.match((await r.json()).message,/If this account exists/);
});
test('session cookies retain security flags during refresh',async()=>{
 let options;
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:(_url,_key,opts)=>{
  options=opts;return {auth:{getUser:async()=>{
   options.cookies.setAll([{name:'__Host-safekeep-auth',value:'rotated',options:{secure:false,httpOnly:false}}]);
   return {data:{user:null}};
  }}};
 }});
 const response=await handler(request());
 const cookie=response.headers.get('set-cookie');
 assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i);assert.match(cookie,/Path=\//i);
 assert.equal(response.headers.get('cache-control'),'private, no-store');
});
// Sign-up handoff (PRD "Sign-up" section): terms acceptance, intent metadata, code verification, checkout handoff.
import {checkIntent,POLICY_VERSION,SIGNUP_REPLY} from '../netlify/functions/account.mjs';
test('intent keeps only known fields and rejects unknown plans',()=>{
 assert.deepEqual(checkIntent({plan:'family',billing:'annual',help_for:'other',invitee_name:'  Mom ',invitee_email:'Mom@Example.com',invitee_phone:'212-555-1234',lead_session_id:'abc-123',user_id:'victim',role:'admin'}),
  {plan:'family',billing:'annual',help_for:'other',invitee_name:'Mom',invitee_email:'mom@example.com',invitee_phone:'212-555-1234',lead_session_id:'abc-123'});
 assert.throws(()=>checkIntent({plan:'enterprise'}),/Check your plan choice/);
 assert.equal(checkIntent({invitee_email:'not an email'}),null);
 assert.equal(checkIntent(undefined),null);
});
test('signup requires the terms checkbox and stores intent and acceptance details as user metadata',async()=>{
 let signUpArgs;
 const s=setup({signUp:async args=>{signUpArgs=args;return {data:{user:{id:'new'},session:null},error:null};}});
 const refused=await s.handler(request({action:'signup',email:'a@example.com',password:'long enough password',adult_confirmed:true}));
 assert.equal(refused.status,400);assert.match((await refused.json()).error,/Terms of Service/);assert.equal(signUpArgs,undefined);
 const ok=await s.handler(new Request(origin+'/api/account',{method:'POST',headers:{origin,'content-type':'application/json','user-agent':'TestBrowser/1','x-nf-client-connection-ip':'203.0.113.9'},
  body:JSON.stringify({action:'signup',email:'A@Example.com',password:'long enough password',adult_confirmed:true,terms_accepted:true,first_name:'Ian',intent:{plan:'pairs',billing:'monthly',help_for:'self',lead_session_id:'sess-1'}})}));
 assert.equal(ok.status,200);assert.match((await ok.json()).message,/verification email/);
 assert.equal(signUpArgs.email,'a@example.com');
 const data=signUpArgs.options.data;
 assert.deepEqual(data.safekeep_intent,{plan:'pairs',billing:'monthly',help_for:'self',lead_session_id:'sess-1'});
 assert.equal(data.safekeep_signup.first_name,'Ian');assert.equal(data.safekeep_signup.terms_version,POLICY_VERSION);assert.ok(data.safekeep_signup.terms_accepted_at);assert.ok(data.safekeep_signup.adult_confirmed_at);
 assert.equal(data.safekeep_signup.user_agent,'TestBrowser/1');assert.match(data.safekeep_signup.ip_hash,/^[0-9a-f]{64}$/);assert.ok(!JSON.stringify(data).includes('203.0.113.9'));
});
test('signup with a bad intent is refused before contacting Supabase',async()=>{
 let called=false;const s=setup({signUp:async()=>{called=true;return {data:{},error:null};}});
 const r=await s.handler(request({action:'signup',email:'a@example.com',password:'long enough password',adult_confirmed:true,terms_accepted:true,intent:{plan:'gold'}}));
 assert.equal(r.status,400);assert.match((await r.json()).error,/Check your plan choice/);assert.equal(called,false);
});
test('signup enforces Turnstile when a secret is configured',async()=>{
 let signedUp=false,verifyBody;
 const fetcher=async(_url,init)=>{verifyBody=init.body;return {ok:true,json:async()=>({success:verifyBody.get('response')==='good-token'})};};
 const client={auth:{signUp:async()=>{signedUp=true;return {data:{user:{}},error:null};}}};
 const handler=makeHandler({env:{APP_ORIGIN:origin,TURNSTILE_SECRET_KEY:'secret'},createClient:()=>client,fetcher});
 const base={action:'signup',email:'a@example.com',password:'long enough password',adult_confirmed:true,terms_accepted:true};
 assert.equal((await handler(request({...base,turnstile_token:'bad'}))).status,400);assert.equal(signedUp,false);
 assert.equal((await handler(request({...base,turnstile_token:'good-token'}))).status,200);assert.equal(signedUp,true);assert.equal(verifyBody.get('secret'),'secret');
});
test('verifying the emailed code signs the person in and records the terms they accepted at sign-up',async()=>{
 const metadata={safekeep_signup:{terms_accepted_at:'2026-10-29T10:00:00.000Z',terms_version:'forged-2030',ip_hash:'abc',user_agent:'UA'}};
 let otpArgs,updated;
 const s=setup({verifyOtp:async args=>{otpArgs=args;return {data:{user:{id:'u',email_confirmed_at:'yes',user_metadata:metadata}},error:null};},updateUser:async args=>{updated=args;return {data:{},error:null};}});
 const r=await s.handler(request({action:'verify_code',email:'a@example.com',code:'123 456'}));
 assert.equal(r.status,200);assert.deepEqual(otpArgs,{email:'a@example.com',token:'123456',type:'signup'});
 assert.deepEqual(s.calls.map(c=>c.args.action),['sync_email','accept_policies']);
 assert.deepEqual(s.calls[1].args.payload,{source:'signup',version:POLICY_VERSION,documents:['terms','privacy'],accepted_at:'2026-10-29T10:00:00.000Z',ip_hash:'abc',user_agent:'UA'});
 assert.equal(updated.data.safekeep_signup.recorded,true);
 const short=await s.handler(request({action:'verify_code',email:'a@example.com',code:'12'}));assert.equal(short.status,400);
});
test('a wrong or expired code never creates a session',async()=>{
 const s=setup({verifyOtp:async()=>({data:{user:null,session:null},error:{message:'Token has expired or is invalid'}})});
 const r=await s.handler(request({action:'verify_code',email:'a@example.com',code:'000000'}));assert.equal(r.status,400);assert.equal(s.calls.length,0);
});
test('terms recorded once: a verified session whose acceptance is already recorded does not write again',async()=>{
 const calls=[];
 const from=fakeFrom();
 const user={id:'user-a',email:'a@example.com',email_confirmed_at:'yes',user_metadata:{safekeep_signup:{terms_accepted_at:'2026-10-29T10:00:00.000Z',recorded:true,first_name:'Ian',adult_confirmed_at:'yes'},safekeep_intent:{plan:'family',billing:'annual',help_for:'other',invitee_name:'Mom'}}};
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:()=>({auth:{getUser:async()=>({data:{user}}),updateUser:async()=>{throw new Error('should not update');}},rpc:async(name,args)=>{calls.push({name,args});return {data:{},error:null};},from})});
 const r=await handler(request());const body=await r.json();
 assert.equal(r.status,200);assert.deepEqual(calls.map(c=>c.args.action),['sync_email']);
 assert.deepEqual(body.intent,{plan:'family',billing:'annual',help_for:'other',invitee_name:'Mom'});assert.deepEqual(body.signup,{first_name:'Ian',adult_confirmed:true});assert.equal(body.policy_version,POLICY_VERSION);
});
test('checkout hands off to the Payment Link keyed to the account, and needs a profile first',async()=>{
 let profileExists=false,updated;
 let acceptances=[];
 const from=table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:profileExists?{user_id:'user-a'}:null,error:null}),eq:async()=>({data:acceptances,error:null})})})});
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'user-a',email:'a@example.com',email_confirmed_at:'yes',user_metadata:{safekeep_intent:{plan:'pairs',billing:'annual'}}}}}),updateUser:async args=>{updated=args;return {data:{},error:null};}},from})});
 assert.equal((await handler(request({action:'checkout'}))).status,400);
 profileExists=true;
 const unaccepted=await handler(request({action:'checkout'}));assert.equal(unaccepted.status,400);assert.match((await unaccepted.json()).error,/Terms of Service/);
 acceptances=[{document:'terms'}];assert.equal((await handler(request({action:'checkout'}))).status,400);
 acceptances=[{document:'terms'},{document:'privacy'}];
 const r=await handler(request({action:'checkout'}));assert.equal(r.status,200);
 const url=new URL((await r.json()).url);
 assert.equal(url.origin,'https://buy.stripe.com');assert.equal(url.searchParams.get('client_reference_id'),'user-a');assert.equal(url.searchParams.get('prefilled_email'),'a@example.com');
 assert.equal(updated.data.safekeep_intent.plan,'pairs');assert.ok(updated.data.safekeep_intent.checkout_started_at);
 assert.equal((await handler(request({action:'checkout',payload:{plan:'gold',billing:'annual'}}))).status,400);
});
test('profile carries the adult attestation given at sign-up so it is not asked twice',async()=>{
 const s=setup({getUser:async()=>({data:{user:{id:'user-a',email:'a@example.com',email_confirmed_at:'yes',user_metadata:{safekeep_signup:{adult_confirmed_at:'2026-10-29T10:00:00.000Z'}}}}})});
 assert.equal((await s.handler(request({action:'profile',payload:{first_name:'Ian',timezone:'America/New_York'}}))).status,200);
 assert.equal(s.calls[0].args.payload.adult_confirmed,true);
});

test('signup replies identically for a new address, an existing one, and the honeypot',async()=>{
 const base={action:'signup',email:'a@example.com',password:'long enough password',adult_confirmed:true,terms_accepted:true};
 const fresh=setup({signUp:async()=>({data:{user:{id:'new'},session:null},error:null})});
 const taken=setup({signUp:async()=>({data:{user:null,session:null},error:{code:'user_already_exists',status:422,message:'User already registered'}})});
 let bot=false;const trap=setup({signUp:async()=>{bot=true;return {data:{},error:null};}});
 const replies=await Promise.all([fresh.handler(request(base)),taken.handler(request(base)),trap.handler(request({...base,website:'http://spam'}))]);
 for(const r of replies){assert.equal(r.status,200);assert.equal((await r.json()).message,SIGNUP_REPLY);}
 assert.equal(bot,false);
});
test('the intent action stamps when the plan was chosen so the sign-in path can tell which choice is newer',async()=>{
 let updated;const s=setup({updateUser:async args=>{updated=args;return {data:{},error:null};}});
 assert.equal((await s.handler(request({action:'intent',payload:{plan:'family',billing:'monthly',role:'admin'}}))).status,200);
 assert.equal(updated.data.safekeep_intent.plan,'family');assert.ok(updated.data.safekeep_intent.updated_at);assert.equal(updated.data.safekeep_intent.role,undefined);
 assert.equal((await s.handler(request({action:'intent',payload:{plan:'family'}}))).status,400);
});
// Settings (PRD "Settings" section): phone verification through Twilio Verify with a server-only proof, export, deletion.
import {phoneProof,verificationChannel} from '../netlify/functions/account.mjs';
import {runCleanup,DELETE_AFTER_DAYS} from '../netlify/functions/scheduled-cleanup.mjs';
const twilioEnv={APP_ORIGIN:origin,TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'tok',TWILIO_VERIFY_SERVICE_SID:'VA1',PHONE_VERIFY_SECRET:'proof-secret'};
const verifiedUser={id:'user-a',email:'a@example.com',email_confirmed_at:'yes',user_metadata:{}};
test('phone verification is unavailable until Twilio is configured, and cells get a text while landlines get a call',async()=>{
 const s=setup();const r=await s.handler(request({action:'phone_verify_start',payload:{contact_id:'11111111-1111-4111-8111-111111111111'}}));assert.equal(r.status,503);
 assert.equal(verificationChannel('mobile'),'sms');assert.equal(verificationChannel('home'),'call');assert.equal(verificationChannel('office'),'call');
});
test('starting verification sends the code to the stored number, never to a number from the request',async()=>{
 const twilioCalls=[];const fetcher=async(url,init)=>{twilioCalls.push({url,body:init.body,auth:init.headers.Authorization});return {ok:true,status:201,json:async()=>({status:'pending'})};};
 const from=fakeFrom({user_contacts:[{id:'11111111-1111-4111-8111-111111111111',kind:'mobile',normalized_value:'+12125550123',verified_at:null}]});
 const handler=makeHandler({env:twilioEnv,fetcher,createClient:()=>({auth:{getUser:async()=>({data:{user:verifiedUser}})},from})});
 const r=await handler(request({action:'phone_verify_start',payload:{contact_id:'11111111-1111-4111-8111-111111111111',to:'+19995550000'}}));
 assert.equal(r.status,200);assert.match((await r.json()).message,/texted/);
 assert.match(twilioCalls[0].url,/\/Services\/VA1\/Verifications$/);assert.equal(twilioCalls[0].body.get('To'),'+12125550123');assert.equal(twilioCalls[0].body.get('Channel'),'sms');assert.match(twilioCalls[0].auth,/^Basic /);
 const missing=await handler(request({action:'phone_verify_start',payload:{contact_id:'not-a-uuid'}}));assert.equal(missing.status,404);
});
test('an approved code records verification through the proof; a rejected code records nothing',async()=>{
 let approved=false;const calls=[];
 const fetcher=async()=>({ok:true,status:200,json:async()=>({status:approved?'approved':'pending'})});
 const from=fakeFrom({user_contacts:[{id:'11111111-1111-4111-8111-111111111111',kind:'home',normalized_value:'+12125550124',verified_at:null}]});
 const handler=makeHandler({env:twilioEnv,fetcher,createClient:()=>({auth:{getUser:async()=>({data:{user:verifiedUser}})},from,rpc:async(name,args)=>{calls.push(args);return {data:{saved:true},error:null};}})});
 assert.equal((await handler(request({action:'phone_verify_check',payload:{contact_id:'11111111-1111-4111-8111-111111111111',code:'123456'}}))).status,400);assert.equal(calls.length,0);
 approved=true;
 const r=await handler(request({action:'phone_verify_check',payload:{contact_id:'11111111-1111-4111-8111-111111111111',code:'123 456'}}));assert.equal(r.status,200);
 assert.equal(calls[0].action,'verify_phone');assert.equal(calls[0].payload.method,'otp_call');
 assert.equal(calls[0].payload.proof,phoneProof('proof-secret','user-a','11111111-1111-4111-8111-111111111111','otp_call'));
 assert.notEqual(calls[0].payload.proof,phoneProof('proof-secret','user-a','11111111-1111-4111-8111-111111111111','otp_sms'));
});
test('export returns the account as a downloadable file scoped to the signed-in user',async()=>{
 const seen=[];const from=table=>{seen.push(table);return fakeFrom({user_profiles:[{user_id:'user-a',first_name:'A'}]})(table);};
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:()=>({auth:{getUser:async()=>({data:{user:verifiedUser}})},from})});
 const r=await handler(request({action:'export'}));assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment; filename="safekeep-export-/);
 const body=await r.json();assert.equal(body.email,'a@example.com');assert.deepEqual(body.profile,[{user_id:'user-a',first_name:'A'}]);assert.ok(seen.includes('consent_events')&&seen.includes('report_recipients'));
});
test('requesting deletion runs the database action and signs out everywhere',async()=>{
 const order=[];const s=setup({signOut:async({scope})=>{order.push('signout:'+scope);return {data:{},error:null};}});
 const r=await s.handler(request({action:'request_deletion'}));assert.equal(r.status,200);
 assert.equal(s.calls[0].args.action,'request_deletion');assert.deepEqual(order,['signout:global']);
});
test('settings passthrough actions reach the database action with their payloads',async()=>{
 const s=setup();
 for(const [action,payload] of [['remove_phone',{contact_id:'c1'}],['add_report_recipient',{name:'D',email:'d@example.com'}],['remove_report_recipient',{recipient_id:'r1'}],['cancel_deletion',undefined]]){
  assert.equal((await s.handler(request({action,payload}))).status,200);
 }
 assert.deepEqual(s.calls.map(c=>c.args.action),['remove_phone','add_report_recipient','remove_report_recipient','cancel_deletion']);
});
test('the daily cleanup deletes expired deletion requests and stale unconfirmed sign-ups, and nothing else',async()=>{
 const now=()=>new Date('2026-12-01T00:00:00Z');const deleted=[];
 const users=[{id:'old-unconfirmed',email_confirmed_at:null,created_at:'2026-10-01T00:00:00Z'},{id:'new-unconfirmed',email_confirmed_at:null,created_at:'2026-11-20T00:00:00Z'},{id:'confirmed',email_confirmed_at:'x',created_at:'2026-01-01T00:00:00Z'},{id:'anon',email_confirmed_at:null,is_anonymous:true,created_at:'2026-01-01T00:00:00Z'}];
 const makeClient=()=>({from:()=>{const b={};for(const m of ['select','is','lte'])b[m]=()=>b;b.then=ok=>ok({data:[{user_id:'requested-old'}],error:null});return b;},auth:{admin:{listUsers:async()=>({data:{users},error:null}),deleteUser:async id=>{deleted.push(id);return {error:null};}}}});
 assert.deepEqual(await runCleanup({env:{},now,makeClient}),{skipped:'SUPABASE_SERVICE_ROLE_KEY is not set'});
 const result=await runCleanup({env:{SUPABASE_SERVICE_ROLE_KEY:'service'},now,makeClient});
 assert.deepEqual(deleted.sort(),['old-unconfirmed','requested-old']);assert.equal(result.deleted,2);assert.equal(result.requested,1);assert.equal(result.unconfirmed,1);assert.equal(DELETE_AFTER_DAYS,30);
});
