import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { createHash, createHmac } from 'node:crypto';

const defaults = {
 url: 'https://iybcbztvofqihvqhqfoo.supabase.co',
 key: 'sb_publishable_zYE3IWYDB4KSj9UZkbLVBg__SDs-7hr'
};
import { POLICY_VERSION } from './lib/policy.mjs';
export { POLICY_VERSION };
// Plans and the Stripe Payment Links that stand in for /api/billing/checkout until the billing phase lands.
// Seat counts are keyed by plan here; the billing phase keys them by Stripe price id.
export const PLANS = { individual:{seats:1,monthly:'$5/month',annual:'$60/year'}, pairs:{seats:2,monthly:'$9/month',annual:'$96/year'}, family:{seats:4,monthly:'$16/month',annual:'$168/year'} };
const STRIPE_LINKS = {
 individual:{monthly:'https://buy.stripe.com/5kQ3cx5Mf4tk11Z7lt8Vi00',annual:'https://buy.stripe.com/aFa9AV1vZgc2dOL9tB8Vi01'},
 pairs:{monthly:'https://buy.stripe.com/28E8wR5Mf0d43a735d8Vi02',annual:'https://buy.stripe.com/14A00l8YrcZQ5ifeNV8Vi03'},
 family:{monthly:'https://buy.stripe.com/5kQ7sNgqT2lc8ur2198Vi04',annual:'https://buy.stripe.com/8x25kFfmP7FwaCz2198Vi05'}
};
// The same reply whether or not the address is already registered, and for the honeypot, so the dialog cannot tell.
export const SIGNUP_REPLY = 'If this address can be registered, a verification email is on its way. Already registered? Sign in instead.';
export function checkPassword(value) {
 if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new Error('Use a password between 12 and 128 characters.');
 return value;
}
export function validateRequest(request, origin) {
 if (!['GET','POST'].includes(request.method)) throw new Error('Method not allowed');
 if (request.method === 'POST' && (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json'))) throw new Error('Request blocked');
}
const emailValue = value => {
 if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address.');
 return value.trim().toLowerCase();
};
const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
// The sign-up intent is what the marketing dialog learned before account creation: the plan to offer at checkout
// and, when the sponsor is buying for someone else, the details that prefill the first invite. It is stored as
// user metadata so it survives verifying in another browser. Nothing in it is trusted for identity or billing.
export function checkIntent(raw) {
 if (raw === undefined || raw === null) return null;
 if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Check your plan choice.');
 const intent = {};
 if (raw.plan !== undefined && raw.plan !== null && raw.plan !== '') { if (!PLANS[raw.plan]) throw new Error('Check your plan choice.'); intent.plan = raw.plan; }
 if (raw.billing !== undefined && raw.billing !== null && raw.billing !== '') { if (!['monthly','annual'].includes(raw.billing)) throw new Error('Check your plan choice.'); intent.billing = raw.billing; }
 if (raw.help_for !== undefined && raw.help_for !== null && raw.help_for !== '') { if (!['self','other'].includes(raw.help_for)) throw new Error('Check your plan choice.'); intent.help_for = raw.help_for; }
 const name = text(raw.invitee_name, 80); if (name) intent.invitee_name = name;
 if (typeof raw.invitee_email === 'string' && raw.invitee_email.trim()) { try { intent.invitee_email = emailValue(raw.invitee_email); } catch { /* a bad prefill is dropped, not fatal */ } }
 const phone = text(raw.invitee_phone, 32); if (phone) intent.invitee_phone = phone;
 if (typeof raw.lead_session_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.lead_session_id)) intent.lead_session_id = raw.lead_session_id;
 if (typeof raw.invite_token === 'string' && /^[0-9a-f]{64}$/.test(raw.invite_token)) intent.invite_token = raw.invite_token;
 return Object.keys(intent).length ? intent : null;
}
const hashIp = (ip, salt) => ip ? createHash('sha256').update(`${salt}|${ip}`).digest('hex') : null;
// Cloudflare Turnstile sits on the account-creation step only (docs/accounts.md item 5). It is enforced when
// TURNSTILE_SECRET_KEY is configured; the matching site key goes in the dialog markup. Fails closed.
async function turnstileOk(secret, token, ip, fetcher) {
 if (typeof token !== 'string' || !token || token.length > 2048) return false;
 try {
  const body = new URLSearchParams({ secret, response: token }); if (ip) body.set('remoteip', ip);
  const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method:'POST', body });
  return response.ok && (await response.json()).success === true;
 } catch { return false; }
}
// Phone verification through Twilio Verify: a text to a cell, or a short automated call that reads the code to a
// landline. Enabled when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID are set. The code is
// checked here, never in the browser, and the database is told only through an HMAC proof under PHONE_VERIFY_SECRET
// (the same value sits in safekeep_private.secrets), so a signed-in user cannot mark a number verified themselves.
// Credentials: a restricted API key (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET) is preferred; the account SID and
// auth token still work as a fallback.
export function twilioAuth(env) {
 if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) return 'Basic ' + Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString('base64');
 if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) return 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
 return null;
}
function twilio(env) {
 const auth = twilioAuth(env);
 if (!auth || !env.TWILIO_VERIFY_SERVICE_SID || !env.PHONE_VERIFY_SECRET) return null;
 const base = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}`;
 return { auth, start: `${base}/Verifications`, check: `${base}/VerificationCheck` };
}
export const verificationChannel = kind => kind === 'mobile' ? 'sms' : 'call';
export const phoneProof = (secret, userId, contactId, method) => createHmac('sha256', secret).update(`${userId}:${contactId}:${method}`).digest('hex');
// A Stripe Checkout Session for one subscription price, keyed to the account: client_reference_id and metadata carry
// the user id, so the webhook can attach the plan without trusting anything the browser sends back. Returns null on
// any Stripe error so the caller can fall back to the Payment Link.
export async function createCheckoutSession({ env, fetcher, origin, user, price, customer, plan, billing }) {
 const body = new URLSearchParams({
  mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
  client_reference_id: user.id, 'metadata[user_id]': user.id, 'metadata[plan]': plan, 'metadata[billing]': billing,
  'subscription_data[metadata][user_id]': user.id,
  success_url: `${origin}/account/?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}/account/?checkout=cancelled`,
  allow_promotion_codes: 'true'
 });
 if (customer) body.set('customer', customer); else body.set('customer_email', user.email);
 if (env.STRIPE_AUTOMATIC_TAX === 'true') { body.set('automatic_tax[enabled]', 'true'); if (customer) body.set('customer_update[address]', 'auto'); }
 // Requires a Terms of Service URL in Stripe's public business details; the webhook records the acceptance.
 if (env.STRIPE_TERMS_AT_CHECKOUT === 'true') body.set('consent_collection[terms_of_service]', 'required');
 try {
  const response = await fetcher('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Idempotency-Key': `checkout-${user.id}-${price}-${Math.floor(Date.now() / 600000)}` }, body });
  const session = await response.json().catch(() => ({}));
  return response.ok && session.url ? session.url : null;
 } catch { return null; }
}
export function makeHandler({ createClient = createServerClient, env = process.env, fetcher = globalThis.fetch, now = () => new Date() } = {}) {
 return async request => {
  const headers = new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
  const reply = (body, status=200) => new Response(JSON.stringify(body), {status,headers});
  const origin = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!origin) return reply({error:'Account setup is not complete yet.'},503);
  try { validateRequest(request, new URL(origin).origin); } catch { return reply({error:'Request blocked.'},403); }
  const secure = !(env.COOKIE_SECURE==='false' && new URL(origin).hostname==='localhost');
  const client = createClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, {
   cookieOptions: {name:secure?'__Host-safekeep-auth':'safekeep-auth',path:'/',httpOnly:true,secure,sameSite:'lax'},
   cookies: {
    getAll:()=>parseCookieHeader(request.headers.get('cookie') || ''),
    setAll:(cookies, cacheHeaders)=>{
     for (const {name,value,options} of cookies) headers.append('Set-Cookie',serializeCookieHeader(name,value,{...options,httpOnly:true,secure,sameSite:'lax',path:'/'}));
     if(cacheHeaders) for(const [name,value] of Object.entries(cacheHeaders)) headers.set(name,value);
    }
   }
  });
  const must = result => { if(result.error) throw result.error; return result.data; };
  const rpc = async(action,payload={})=>must(await client.rpc('account_action',{action,payload}));
  const clientIp = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || null;
  // Runs once a verified session exists: syncs the login email and records the terms accepted at sign-up.
  // Metadata is user-editable, so it decides only whether the box was ticked at sign-up and when; the version
  // recorded is the server's. A version bump between sign-up and verification records the current version.
  const finishSignup = async user => {
   await rpc('sync_email');
   const signup = user?.user_metadata?.safekeep_signup;
   if (signup?.terms_accepted_at && !signup.recorded) {
    const source=user?.user_metadata?.safekeep_intent?.invite_token?'invite_accept':'signup';
    await rpc('accept_policies',{source,version:POLICY_VERSION,documents:['terms','privacy'],accepted_at:signup.terms_accepted_at,ip_hash:signup.ip_hash || null,user_agent:signup.user_agent || null});
    await client.auth.updateUser({data:{safekeep_signup:{...signup,recorded:true}}});
   }
  };
  let action='state';
  try {
   let body={};
   if(request.method==='POST') {
    const raw=await request.text();
    if(raw.length>8192) return reply({error:'Request is too large.'},413);
    try { body=JSON.parse(raw); } catch { return reply({error:'Invalid request.'},400); }
    action=body.action;
   }
   const redirect = `${new URL(origin).origin}/account/`;
   if(action==='signup') {
    const email=emailValue(body.email); const password=checkPassword(body.password);
    if(body.adult_confirmed!==true) return reply({error:'Safekeep accounts are for adults. Confirm you are at least 18.'},400);
    if(body.terms_accepted!==true) return reply({error:'Accept the Terms of Service and Privacy Policy to continue.'},400);
    if(typeof body.website==='string' && body.website) return reply({message:SIGNUP_REPLY}); // honeypot
    const intent=checkIntent(body.intent);
    if(env.TURNSTILE_SECRET_KEY && !(await turnstileOk(env.TURNSTILE_SECRET_KEY, body.turnstile_token, clientIp, fetcher))) return reply({error:'Please complete the security check and try again.'},400);
    const accepted=now().toISOString();
    const data={
     safekeep_signup:{first_name:text(body.first_name,80),adult_confirmed_at:accepted,terms_version:POLICY_VERSION,terms_accepted_at:accepted,ip_hash:hashIp(clientIp, env.POLICY_IP_SALT || origin),user_agent:text(request.headers.get('user-agent'),512)},
     ...(intent?{safekeep_intent:intent}:{})
    };
    const result=await client.auth.signUp({email,password,options:{emailRedirectTo:redirect,data}});
    // Always require email confirmation, even if dashboard settings are accidentally permissive.
    if(result.data?.session) await client.auth.signOut({scope:'local'});
    if(result.error && result.error.status===429) return reply({error:'Please wait before trying again.'},429);
    if(result.error && !['user_already_exists','email_exists'].includes(result.error.code)) return reply({error:'Unable to send a verification email. Please try again later.'},400);
    return reply({message:SIGNUP_REPLY});
   }
   if(action==='login') {
    const {data,error}=await client.auth.signInWithPassword({email:emailValue(body.email),password:String(body.password || '')});
    if(error || !data.user?.email_confirmed_at || data.user?.is_anonymous) {
     if(data.session) await client.auth.signOut({scope:'local'});
     return reply({error:'Unable to sign in. Check your details and verify your email.'},401);
    }
    await finishSignup(data.user);
    return reply({message:'Signed in.'});
   }
   if(action==='recover') {
    await client.auth.resetPasswordForEmail(emailValue(body.email),{redirectTo:`${redirect}?flow=recovery`});
    return reply({message:'If this account exists, a reset email is on its way. Open it in this browser.'});
   }
   if(action==='resend') {
    await client.auth.resend({type:'signup',email:emailValue(body.email),options:{emailRedirectTo:redirect}});
    return reply({message:'If verification is needed, an email is on its way.'});
   }
   if(action==='verify_code') {
    // The six-digit code from the verification email. Works from any device, which the PKCE link does not.
    const email=emailValue(body.email); const token=String(body.code || '').replace(/\D/g,'');
    if(token.length<6 || token.length>10) return reply({error:'Enter the 6-digit code from the email.'},400);
    const {data,error}=await client.auth.verifyOtp({email,token,type:'signup'});
    if(error && error.status===429) return reply({error:'Please wait before trying again.'},429);
    if(error || !data.user?.email_confirmed_at) return reply({error:'That code is not right or has expired. Request a new email and try again.'},400);
    await finishSignup(data.user);
    return reply({message:'Email verified.'});
   }
   if(action==='confirm') {
    if(typeof body.code!=='string' || body.code.length>200) return reply({error:'Invalid verification link.'},400);
    if(body.new_password!==undefined) checkPassword(body.new_password);
    const {data,error}=await client.auth.exchangeCodeForSession(body.code);
    if(error || !data.user?.email_confirmed_at) return reply({error:'This link expired or was opened in another browser. Request a new email, or enter the code from it instead.'},400);
    if(data.redirectType==='recovery') {
     if(!body.new_password) { await client.auth.signOut({scope:'local'}); return reply({error:'Request a new reset email, then enter a new password.'},400); }
     must(await client.auth.updateUser({password:body.new_password}));
     must(await client.auth.signOut({scope:'global'}));
     return reply({message:'Password updated. Sign in with your new password.'});
    }
    if(body.new_password) { await client.auth.signOut({scope:'local'}); return reply({error:'Use a password-reset email to reset your password.'},400); }
    await finishSignup(data.user);
    return reply({message:'Email verified. Finish your profile below.'});
   }
   const {data:{user},error}=await client.auth.getUser();
   if(error || !user || !user.email_confirmed_at || user.is_anonymous) return reply({signed_in:false},401);
   const meta=user.user_metadata || {};
   if(action==='logout') { must(await client.auth.signOut({scope:'local'})); return reply({message:'Signed out.'}); }
   if(action==='password') {
    checkPassword(body.new_password);
    const result=await client.auth.signInWithPassword({email:user.email,password:String(body.current_password||'')});
    if(result.error || result.data.user?.id!==user.id) return reply({error:'Current password was not accepted.'},401);
    must(await client.auth.updateUser({password:body.new_password}));
    must(await client.auth.signOut({scope:'global'}));
    return reply({message:'Password changed. Sign in again.'});
   }
   if(action==='state') {
    await finishSignup(user);
    const [profile,preferences,contacts,consents,acceptances,recipients,pendingDeletion,subscriptions,members,sponsorship,seats,practising,history]=await Promise.all([
     client.from('user_profiles').select('*').eq('user_id',user.id).maybeSingle(),
     client.from('user_preferences').select('*').eq('user_id',user.id).maybeSingle(),
     client.from('user_contacts').select('*').eq('user_id',user.id).order('created_at'),
     client.from('consent_events').select('contact_id,channel,action,sequence').eq('user_id',user.id).order('sequence',{ascending:false}),
     client.from('policy_acceptances').select('document,version,source,accepted_at').eq('user_id',user.id).order('accepted_at',{ascending:false}),
     client.from('report_recipients').select('id,name,email,added_at').eq('participant_user_id',user.id).is('removed_at',null).order('added_at'),
     client.from('account_deletions').select('requested_at,cancelled_at').eq('user_id',user.id).maybeSingle(),
     client.from('subscriptions').select('id,plan,billing,seats,status,current_period_end,cancel_at,canceled_at,ended_at,past_due_since,refunded_at,created_at').eq('sponsor_user_id',user.id).order('created_at',{ascending:false}).limit(1),
     client.from('subscription_members').select('subscription_id,user_id,role,status,joined_at').eq('role','participant').in('status',['active','paused']),
     client.rpc('my_sponsorship'),
     client.rpc('sponsor_seats'),
     client.rpc('is_active_participant',{who:user.id}),
     client.rpc('my_practice_history')
    ]);
    const signup=meta.safekeep_signup || {};
    const deletion=must(pendingDeletion);
    return reply({signed_in:true,email:user.email,profile:must(profile),preferences:must(preferences),contacts:must(contacts),consents:must(consents),acceptances:must(acceptances),
     report_recipients:must(recipients),deletion:deletion && !deletion.cancelled_at?{requested_at:deletion.requested_at,delete_after:new Date(new Date(deletion.requested_at).getTime()+30*86400000).toISOString()}:null,
     phone_verification:!!twilio(env),billing_portal:!!env.STRIPE_SECRET_KEY,
     // The sponsor's latest plan with the seats in use (participants on it, by seat ledger), and the plan this person
     // is a participant on, if someone else pays.
     subscription:(()=>{const sub=must(subscriptions)?.[0];if(!sub)return null;const seatRows=must(members)||[];return {...sub,seats_used:seatRows.filter(m=>m.subscription_id===sub.id).length};})(),
     membership:(must(sponsorship)||[])[0]||null,
     seats:must(seats)||[],practising:!!must(practising),practice_history:must(history)||[],
     intent:meta.safekeep_intent || null,signup:{first_name:signup.first_name || null,adult_confirmed:!!signup.adult_confirmed_at},policy_version:POLICY_VERSION,plans:PLANS});
   }
   if(action==='phone_verify_start' || action==='phone_verify_check') {
    const provider=twilio(env);
    if(!provider) return reply({error:'Phone verification isn’t available yet.'},503);
    const contactId=String(body.payload?.contact_id || '');
    if(!/^[0-9a-f-]{36}$/.test(contactId)) return reply({error:'Contact not found.'},404);
    const contact=must(await client.from('user_contacts').select('id,kind,normalized_value,verified_at').eq('user_id',user.id).eq('id',contactId).maybeSingle());
    if(!contact || contact.kind==='email') return reply({error:'Contact not found.'},404);
    const channel=verificationChannel(contact.kind);
    if(action==='phone_verify_start') {
     const response=await fetcher(provider.start,{method:'POST',headers:{Authorization:provider.auth},body:new URLSearchParams({To:contact.normalized_value,Channel:channel})});
     if(response.status===429) return reply({error:'Please wait before trying again.'},429);
     if(!response.ok) return reply({error:channel==='sms'?'We couldn’t text that number. Check it and try again.':'We couldn’t call that number. Check it and try again.'},400);
     return reply({message:channel==='sms'?'We texted a 6-digit code to that number.':'We’re calling that number now with a 6-digit code.',channel});
    }
    const code=String(body.payload?.code || '').replace(/\D/g,'');
    if(code.length<4 || code.length>10) return reply({error:'Enter the 6-digit code.'},400);
    const response=await fetcher(provider.check,{method:'POST',headers:{Authorization:provider.auth},body:new URLSearchParams({To:contact.normalized_value,Code:code})});
    if(response.status===429) return reply({error:'Please wait before trying again.'},429);
    const result=response.ok?await response.json():{};
    if(result.status!=='approved') return reply({error:'That code is not right or has expired. Send a new one and try again.'},400);
    const method=channel==='sms'?'otp_sms':'otp_call';
    await rpc('verify_phone',{contact_id:contact.id,method,proof:phoneProof(env.PHONE_VERIFY_SECRET,user.id,contact.id,method)});
    return reply({message:'Number verified.'});
   }
   if(action==='export') {
    // Everything the account holds, as one JSON file the person downloads while signed in.
    const tables=[['profile','user_profiles','user_id'],['preferences','user_preferences','user_id'],['contacts','user_contacts','user_id'],['consent_events','consent_events','user_id'],['policy_acceptances','policy_acceptances','user_id'],['practices','user_practices','user_id'],['report_recipients','report_recipients','participant_user_id'],['deletion','account_deletions','user_id']];
    const rows=await Promise.all(tables.map(([,table,column])=>client.from(table).select('*').eq(column,user.id)));
    const data={exported_at:now().toISOString(),email:user.email,created_at:user.created_at,email_confirmed_at:user.email_confirmed_at};
    tables.forEach(([key],i)=>{data[key]=must(rows[i]);});
    headers.set('Content-Disposition',`attachment; filename="safekeep-export-${now().toISOString().slice(0,10)}.json"`);
    return reply(data);
   }
   if(action==='request_deletion') {
    const result=await rpc('request_deletion');
    must(await client.auth.signOut({scope:'global'}));
    return reply({message:'Your account will be deleted in 30 days. Sign in before then to keep it.',delete_after:result?.delete_after || null});
   }
   if(action==='intent') {
    // The plan picker on /account/, for people who arrived without the dialog or want to change their choice.
    const intent=checkIntent(body.payload);
    if(!intent?.plan || !intent?.billing) return reply({error:'Choose a plan and a billing period.'},400);
    must(await client.auth.updateUser({data:{safekeep_intent:{...(meta.safekeep_intent||{}),...intent,updated_at:now().toISOString()}}}));
    return reply({message:'Plan saved.'});
   }
   if(action==='checkout') {
    // Interim handoff to the Stripe Payment Link for the chosen plan, keyed to this account. The billing phase
    // replaces this with a server-created Checkout session and webhooks; the response shape ({url}) stays.
    const intent=meta.safekeep_intent || {};
    const plan=body.payload?.plan || intent.plan, billing=body.payload?.billing || intent.billing;
    if(!PLANS[plan] || !['monthly','annual'].includes(billing)) return reply({error:'Choose a plan and a billing period.'},400);
    const live=must(await client.from('subscriptions').select('id').eq('sponsor_user_id',user.id).in('status',['trialing','active','past_due']).limit(1));
    if(live?.length) return reply({error:'You already have a plan. Use Manage subscription to change it.'},400);
    const profile=must(await client.from('user_profiles').select('user_id').eq('user_id',user.id).maybeSingle());
    if(!profile) return reply({error:'Finish your profile first.'},400);
    const accepted=must(await client.from('policy_acceptances').select('document').eq('user_id',user.id).eq('version',POLICY_VERSION));
    if(!['terms','privacy'].every(d=>accepted.some(a=>a.document===d))) return reply({error:'Accept the current Terms of Service and Privacy Policy first.'},400);
    let url=null;
    if(env.STRIPE_SECRET_KEY) {
     const price=must(await client.from('price_plans').select('price_id').eq('plan',plan).eq('billing',billing).eq('active',true).limit(1))?.[0]?.price_id;
     // A returning sponsor keeps their Stripe customer (from their latest plan, written only by the webhook).
     const previous=must(await client.from('subscriptions').select('stripe_customer_id').eq('sponsor_user_id',user.id).order('created_at',{ascending:false}).limit(1))?.[0]?.stripe_customer_id;
     if(price) url=await createCheckoutSession({env,fetcher,origin:new URL(origin).origin,user,price,customer:previous,plan,billing});
    }
    if(!url) { // No Stripe key, no price row, or Stripe refused: the Payment Link still works and is keyed to the account.
     const link=new URL(STRIPE_LINKS[plan][billing]);
     link.searchParams.set('client_reference_id',user.id);
     link.searchParams.set('prefilled_email',user.email);
     url=link.toString();
    }
    must(await client.auth.updateUser({data:{safekeep_intent:{...intent,plan,billing,checkout_started_at:now().toISOString()}}}));
    return reply({url});
   }
   if(['invite','resend_invite','revoke_invite','join_own_plan','remove_participant','accept_invitation'].includes(action)) {
    const map={invite:'invite',resend_invite:'resend',revoke_invite:'revoke',join_own_plan:'join_own_plan',remove_participant:'remove_participant',accept_invitation:'accept'};
    const payload=body.payload && typeof body.payload==='object' && !Array.isArray(body.payload)?body.payload:{};
    const result=await client.rpc('invitation_action',{action:map[action],payload});
    if(result.error) throw result.error;
    // Once accepted, the token has done its job; drop it from the account's metadata.
    if(action==='accept_invitation' && meta.safekeep_intent?.invite_token) { const {invite_token, ...rest}=meta.safekeep_intent; await client.auth.updateUser({data:{safekeep_intent:rest}}); }
    const messages={invite:'Invitation sent. We’ll email them now.',resend_invite:'A fresh invitation is on its way.',revoke_invite:'Invitation cancelled.',join_own_plan:'You’re on your plan now. Choose how you’d like to practise below.',remove_participant:'They’ve been taken off your plan and told by email.',accept_invitation:'Welcome to Safekeep. Choose how you’d like to practise below.'};
    return reply({message:messages[action]});
   }
   if(['was_this_safekeep','confirm_report','practice_view','practice_answer','practice_share'].includes(action)) {
    // "Was this Safekeep?" and the coaching page reopened from the history, once its link has expired.
    const map={was_this_safekeep:'was_this_safekeep',confirm_report:'confirm_report',practice_view:'view',practice_answer:'answer',practice_share:'share'};
    const payload=body.payload && typeof body.payload==='object' && !Array.isArray(body.payload)?body.payload:{};
    const result=must(await client.rpc('practice_action',{action:map[action],payload}));
    if(action==='practice_share') return reply({message:'Sent. They’ll get an email with a link to this page.'});
    return reply({result});
   }
   if(action==='accept_policies') {
    // Re-acceptance after a version bump, or acceptance from a flow that has no sign-up metadata.
    await rpc('accept_policies',{source:body.payload?.source==='reprompt'?'reprompt':'signup',version:POLICY_VERSION,documents:['terms','privacy'],ip_hash:hashIp(clientIp, env.POLICY_IP_SALT || origin),user_agent:text(request.headers.get('user-agent'),512)});
    return reply({message:'Saved.'});
   }
   if(['profile','add_phone','consent','preferences','remove_phone','add_report_recipient','remove_report_recipient','cancel_deletion','leave_subscription'].includes(action)) {
    const payload=body.payload || {};
    if(typeof payload!=='object' || Array.isArray(payload)) return reply({error:'Invalid form.'},400);
    // The adult attestation given at account creation carries over, so the profile form does not ask twice.
    if(action==='profile' && payload.adult_confirmed!==true && meta.safekeep_signup?.adult_confirmed_at) payload.adult_confirmed=true;
    await rpc(action,payload); return reply({message:'Saved.'});
   }
   return reply({error:'Unknown action.'},400);
  } catch(error) {
   // Never log credentials, tokens, personal data or the request body.
   if(error?.code==='23505') return reply({error:'That contact is already saved.'},409);
   const safeMessages=['Use a password','Enter your first name','Confirm you are at least 18','Enter an adult date','Choose a valid timezone','Use international format','Choose a phone type','Check phone label','Only email practice consent','Contact not found','Choose an email contact','Verify this email first','Finish your profile first','Give consent for a verified email','Enter a valid email','Check your plan choice','Choose where the terms','Check the policy version','Choose the documents','Choose a phone contact','Choose a channel','Choose grant or revoke','Text practice needs a cell','Verify this number first','Keep your account first','Give consent for a verified contact','Choose a resume date','Enter their name','Up to five people','That person already','No deletion is pending','Phone verification is not configured','Choose a verification method','You are not on someone','You already have a plan','Start a plan first','Every seat on your plan','Enter their email address','Enter their first name','To practise yourself','Keep the note under','That person already has','Invitation not found','That invitation is closed','You are already practising','Participant not found','This invitation','Sign in with the email address','This plan is no longer active','Choose email, text or phone call','Practice not found','Choose one of the three',"You've shared this one"];
   const message=String(error?.message||'');
   return reply({error:safeMessages.some(prefix=>message.startsWith(prefix))?message:'Unable to complete this request. Please try again.'},400);
  }
 };
}
export default makeHandler();
export const config={path:'/api/account'};
