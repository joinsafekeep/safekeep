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
function fakeFrom(rows={}){return table=>{const data=rows[table]||[];const b={};for(const m of ['select','eq','is','in','order','limit'])b[m]=()=>b;b.maybeSingle=async()=>({data:data[0]||null,error:null});b.then=(ok)=>ok({data,error:null});return b;};}
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
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:()=>({auth:{getUser:async()=>({data:{user}}),updateUser:async()=>{throw new Error('should not update');}},rpc:async(name,args)=>{if(['my_sponsorship','sponsor_seats','my_practice_history'].includes(name))return {data:[],error:null};if(name==='is_active_participant')return {data:false,error:null};calls.push({name,args});return {data:{},error:null};},from})});
 const r=await handler(request());const body=await r.json();
 assert.equal(r.status,200);assert.deepEqual(calls.map(c=>c.args.action),['sync_email']);assert.equal(body.subscription,null);assert.equal(body.membership,null);assert.deepEqual(body.seats,[]);
 assert.deepEqual(body.intent,{plan:'family',billing:'annual',help_for:'other',invitee_name:'Mom'});assert.deepEqual(body.signup,{first_name:'Ian',adult_confirmed:true});assert.equal(body.policy_version,POLICY_VERSION);
});
test('checkout hands off to the Payment Link keyed to the account, and needs a profile first',async()=>{
 let profileExists=false,updated;
 let acceptances=[];
 let live=[];
 const from=table=>{if(table==='subscriptions'){const b={};for(const m of ['select','eq','in'])b[m]=()=>b;b.limit=async()=>({data:live,error:null});return b;}return {select:()=>({eq:()=>({maybeSingle:async()=>({data:profileExists?{user_id:'user-a'}:null,error:null}),eq:async()=>({data:acceptances,error:null})})})};};
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
 live=[{id:'sub-1'}];const already=await handler(request({action:'checkout'}));assert.equal(already.status,400);assert.match((await already.json()).error,/already have a plan/);
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
// Phase 2: server-created Checkout with Payment Link fallback; Twilio API-key credentials.
import {createCheckoutSession,twilioAuth} from '../netlify/functions/account.mjs';
test('checkout creates a Stripe Checkout Session keyed to the account, reusing a returning sponsor’s customer',async()=>{
 let sent;const fetcher=async(url,init)=>{sent={url,body:init.body,headers:init.headers};return {ok:true,json:async()=>({url:'https://checkout.stripe.com/c/pay/cs_test'})};};
 const tables={price_plans:[{price_id:'price_pairs_annual'}],subscriptions:[],user_profiles:[{user_id:'user-a'}],policy_acceptances:[{document:'terms'},{document:'privacy'}]};
 const from=table=>{if(table==='subscriptions'){const b={};let live=false;for(const m of ['select','eq','order'])b[m]=()=>b;b.in=()=>{live=true;return b;};b.limit=async()=>({data:live?[]:tables.subscriptions,error:null});return b;}const rows=tables[table];const b={};for(const m of ['select','eq','order'])b[m]=()=>b;b.limit=async()=>({data:rows,error:null});b.maybeSingle=async()=>({data:rows[0]||null,error:null});b.then=ok=>ok({data:rows,error:null});return b;};
 const handler=makeHandler({env:{APP_ORIGIN:origin,STRIPE_SECRET_KEY:'rk_test'},fetcher,createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'user-a',email:'a@example.com',email_confirmed_at:'yes',user_metadata:{safekeep_intent:{plan:'pairs',billing:'annual'}}}}}),updateUser:async()=>({data:{},error:null})},from})});
 const r=await handler(request({action:'checkout'}));assert.equal(r.status,200);assert.equal((await r.json()).url,'https://checkout.stripe.com/c/pay/cs_test');
 assert.equal(sent.url,'https://api.stripe.com/v1/checkout/sessions');assert.equal(sent.body.get('line_items[0][price]'),'price_pairs_annual');assert.equal(sent.body.get('client_reference_id'),'user-a');
 assert.equal(sent.body.get('subscription_data[metadata][user_id]'),'user-a');assert.equal(sent.body.get('customer_email'),'a@example.com');assert.equal(sent.body.get('customer'),null);
 assert.match(sent.body.get('success_url'),/\/account\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/);assert.match(sent.headers.Authorization,/^Bearer rk_test$/);
 tables.subscriptions=[{stripe_customer_id:'cus_old'}];
 await handler(request({action:'checkout'}));assert.equal(sent.body.get('customer'),'cus_old');assert.equal(sent.body.get('customer_email'),null);
});
test('checkout falls back to the Payment Link when Stripe refuses or no key is set',async()=>{
 const url=await createCheckoutSession({env:{STRIPE_SECRET_KEY:'rk'},fetcher:async()=>({ok:false,json:async()=>({error:{type:'invalid_request_error'}})}),origin,user:{id:'u',email:'a@example.com'},price:'p',plan:'pairs',billing:'annual'});
 assert.equal(url,null);
 const thrown=await createCheckoutSession({env:{STRIPE_SECRET_KEY:'rk'},fetcher:async()=>{throw new Error('network');},origin,user:{id:'u',email:'a@example.com'},price:'p',plan:'pairs',billing:'annual'});
 assert.equal(thrown,null);
});
test('checkout opts into Stripe Tax and terms collection only when configured',async()=>{
 let body;const fetcher=async(_u,init)=>{body=init.body;return {ok:true,json:async()=>({url:'x'})};};
 await createCheckoutSession({env:{STRIPE_SECRET_KEY:'rk'},fetcher,origin,user:{id:'u',email:'e@x.com'},price:'p',plan:'pairs',billing:'annual'});
 assert.equal(body.get('automatic_tax[enabled]'),null);assert.equal(body.get('consent_collection[terms_of_service]'),null);
 await createCheckoutSession({env:{STRIPE_SECRET_KEY:'rk',STRIPE_AUTOMATIC_TAX:'true',STRIPE_TERMS_AT_CHECKOUT:'true'},fetcher,origin,user:{id:'u',email:'e@x.com'},price:'p',plan:'pairs',billing:'annual'});
 assert.equal(body.get('automatic_tax[enabled]'),'true');assert.equal(body.get('consent_collection[terms_of_service]'),'required');
});
test('Twilio credentials prefer the restricted API key over the auth token',()=>{
 const dec=h=>Buffer.from(h.slice(6),'base64').toString();
 assert.equal(dec(twilioAuth({TWILIO_API_KEY_SID:'SK1',TWILIO_API_KEY_SECRET:'sec',TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'tok'})),'SK1:sec');
 assert.equal(dec(twilioAuth({TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'tok'})),'AC1:tok');
 assert.equal(twilioAuth({}),null);
});

// Phase 3: invitations through the account function and the public invite endpoint.
import {makeHandler as invitesHandler} from '../netlify/functions/invites.mjs';
import {runInvitationJob} from '../netlify/functions/scheduled-invitations.mjs';
test('invitation actions map onto the database action and never expose a token',async()=>{
 const calls=[];let updated;
 const handler=makeHandler({env:{APP_ORIGIN:origin},createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'mom',email:'mom@example.com',email_confirmed_at:'yes',user_metadata:{safekeep_intent:{invite_token:'a'.repeat(64),plan:null}}}}}),updateUser:async a=>{updated=a;return {data:{},error:null};}},rpc:async(name,args)=>{calls.push({name,args});return {data:{saved:true},error:null};}})});
 for(const [action,payload] of [['invite',{invitee_name:'Mom',invitee_email:'mom@example.com'}],['resend_invite',{invitation_id:'i1'}],['revoke_invite',{invitation_id:'i1'}],['join_own_plan',undefined],['remove_participant',{member_id:'m1'}],['accept_invitation',{token:'a'.repeat(64)}]]){
  const r=await handler(request({action,payload}));assert.equal(r.status,200);assert.ok(!JSON.stringify(await r.json()).match(/[0-9a-f]{64}/));
 }
 assert.deepEqual(calls.map(c=>c.args.action),['invite','resend','revoke','join_own_plan','remove_participant','accept']);
 assert.equal(calls.every(c=>c.name==='invitation_action'),true);
 assert.equal(updated.data.safekeep_intent.invite_token,undefined);
});
test('a signup started from an invitation records the terms as invite_accept',async()=>{
 const s=setup({verifyOtp:async()=>({data:{user:{id:'u',email_confirmed_at:'yes',user_metadata:{safekeep_signup:{terms_accepted_at:'2026-10-29T10:00:00.000Z'},safekeep_intent:{invite_token:'b'.repeat(64)}}}},error:null}),updateUser:async()=>({data:{},error:null})});
 await s.handler(request({action:'verify_code',email:'mom@example.com',code:'123456'}));
 assert.equal(s.calls[1].args.payload.source,'invite_accept');
 assert.deepEqual(checkIntent({invite_token:'c'.repeat(64),plan:'pairs'}),{plan:'pairs',invite_token:'c'.repeat(64)});
 assert.equal(checkIntent({invite_token:'not-a-token'}),null);
});
test('the public invite endpoint looks up by token and declines, as the anonymous role',async()=>{
 const rpcs=[];let keyUsed;
 const makeClient=(_u,key)=>{keyUsed=key;return {rpc:async(name,args)=>{rpcs.push({name,args});if(name==='invitation_by_token')return {data:args.token==='d'.repeat(64)?[{invitee_name:'Mom',sponsor_name:'Ian'}]:[],error:null};return {data:{saved:true},error:null};}};};
 const handler=invitesHandler({env:{APP_ORIGIN:origin},makeClient});
 const found=await (await handler(new Request(origin+'/api/invites?t='+'d'.repeat(64)))).json();assert.equal(found.found,true);assert.equal(found.invitation.sponsor_name,'Ian');
 assert.equal((await (await handler(new Request(origin+'/api/invites?t=nope'))).json()).found,false);
 assert.match(keyUsed,/^sb_publishable_/);
 const d=await handler(new Request(origin+'/api/invites',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'decline',token:'d'.repeat(64)})}));
 assert.equal((await d.json()).declined,true);
 assert.equal((await handler(new Request(origin+'/api/invites',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'}))).status,403);
 assert.deepEqual(rpcs.map(r=>r.name),['invitation_by_token','decline_invitation']);
});
test('the daily invitation job reminds at day 3 and day 10, then lapses at day 14 and tells the sponsor once',async()=>{
 const NOW=new Date('2026-11-12T12:00:00Z');const day=n=>new Date(NOW.getTime()-n*86400000).toISOString();
 const rows=[{id:'d2',inviter_user_id:'s',invitee_email:'a@x.com',invitee_name:'A',created_at:day(2),expires_at:day(-12)},{id:'d4',inviter_user_id:'s',invitee_email:'b@x.com',invitee_name:'B',created_at:day(4),expires_at:day(-10)},{id:'d11',inviter_user_id:'s',invitee_email:'c@x.com',invitee_name:'C',created_at:day(11),expires_at:day(-3),reminded_day3_at:day(8)},{id:'d15',inviter_user_id:'s',invitee_email:'d@x.com',invitee_name:'D',created_at:day(15),expires_at:day(1)}];
 const emails=[],updates=[];
 const makeClient=()=>({from:table=>{const b={};for(const m of ['select','is','eq'])b[m]=()=>b;b.maybeSingle=async()=>({data:{first_name:'Ian'},error:null});b.update=v=>({eq:async(_c,id)=>{updates.push([id,Object.keys(v).find(k=>k!=='updated_at')]);return {error:null};}});b.insert=async v=>{emails.push(v);return {error:null};};b.then=ok=>ok({data:table==='participant_invitations'?rows:[],error:null});return b;},auth:{admin:{getUserById:async()=>({data:{user:{email:'sponsor@x.com'}}})}}});
 const result=await runInvitationJob({env:{SUPABASE_SERVICE_ROLE_KEY:'s'},now:()=>NOW,makeClient});
 assert.deepEqual(result,{open:4,reminders:2,expired:1});
 assert.deepEqual(updates.sort(),[['d11','reminded_day10_at'],['d15','expired_notified_at'],['d4','reminded_day3_at']]);
 assert.deepEqual(emails.map(e=>[e.to_email,e.kind]).sort(),[['b@x.com','invitation_reminder'],['c@x.com','invitation_reminder'],['sponsor@x.com','invitation_expired']]);
});
