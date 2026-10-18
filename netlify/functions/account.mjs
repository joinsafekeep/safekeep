import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';

const defaults = {
 url: 'https://iybcbztvofqihvqhqfoo.supabase.co',
 key: 'sb_publishable_zYE3IWYDB4KSj9UZkbLVBg__SDs-7hr'
};
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
export function makeHandler({ createClient = createServerClient, env = process.env } = {}) {
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
    const result=await client.auth.signUp({email,password,options:{emailRedirectTo:redirect}});
    // Always require email confirmation, even if dashboard settings are accidentally permissive.
    if(result.data?.session) await client.auth.signOut({scope:'local'});
    if(result.error && result.error.status===429) return reply({error:'Please wait before trying again.'},429);
    if(result.error && !['user_already_exists','email_exists'].includes(result.error.code)) return reply({error:'Unable to send a verification email. Please try again later.'},400);
    return reply({message:'If this address can be registered, a verification email is on its way. Open it in this browser. Already registered? Sign in instead.'});
   }
   if(action==='login') {
    const {data,error}=await client.auth.signInWithPassword({email:emailValue(body.email),password:String(body.password || '')});
    if(error || !data.user?.email_confirmed_at || data.user?.is_anonymous) {
     if(data.session) await client.auth.signOut({scope:'local'});
     return reply({error:'Unable to sign in. Check your details and verify your email.'},401);
    }
    await rpc('sync_email');
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
   if(action==='confirm') {
    if(typeof body.code!=='string' || body.code.length>200) return reply({error:'Invalid verification link.'},400);
    if(body.new_password!==undefined) checkPassword(body.new_password);
    const {data,error}=await client.auth.exchangeCodeForSession(body.code);
    if(error || !data.user?.email_confirmed_at) return reply({error:'This link expired or was opened in another browser. Request a new email.'},400);
    if(data.redirectType==='recovery') {
     if(!body.new_password) { await client.auth.signOut({scope:'local'}); return reply({error:'Request a new reset email, then enter a new password.'},400); }
     must(await client.auth.updateUser({password:body.new_password}));
     must(await client.auth.signOut({scope:'global'}));
     return reply({message:'Password updated. Sign in with your new password.'});
    }
    if(body.new_password) { await client.auth.signOut({scope:'local'}); return reply({error:'Use a password-reset email to reset your password.'},400); }
    await rpc('sync_email');
    return reply({message:'Email verified. Finish your profile below.'});
   }
   const {data:{user},error}=await client.auth.getUser();
   if(error || !user || !user.email_confirmed_at || user.is_anonymous) return reply({signed_in:false},401);
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
    await rpc('sync_email');
    const [profile,preferences,contacts,consents]=await Promise.all([
     client.from('user_profiles').select('*').eq('user_id',user.id).maybeSingle(),
     client.from('user_preferences').select('*').eq('user_id',user.id).maybeSingle(),
     client.from('user_contacts').select('*').eq('user_id',user.id).order('created_at'),
     client.from('consent_events').select('contact_id,channel,action,sequence').eq('user_id',user.id).order('sequence',{ascending:false})
    ]);
    return reply({signed_in:true,email:user.email,profile:must(profile),preferences:must(preferences),contacts:must(contacts),consents:must(consents)});
   }
   if(['profile','add_phone','consent','preferences'].includes(action)) {
    const payload=body.payload;
    if(!payload || typeof payload!=='object' || Array.isArray(payload)) return reply({error:'Invalid form.'},400);
    await rpc(action,payload); return reply({message:'Saved.'});
   }
   return reply({error:'Unknown action.'},400);
  } catch(error) {
   // Never log credentials, tokens, personal data or the request body.
   if(error?.code==='23505') return reply({error:'That contact is already saved.'},409);
   const safeMessages=['Use a password','Enter your first name','Confirm you are at least 18','Enter an adult date','Choose a valid timezone','Use international format','Choose a phone type','Check phone label','Only email practice consent','Contact not found','Choose an email contact','Verify this email first','Finish your profile first','Give consent for a verified email','Enter a valid email'];
   const message=String(error?.message||'');
   return reply({error:safeMessages.some(prefix=>message.startsWith(prefix))?message:'Unable to complete this request. Please try again.'},400);
  }
 };
}
export default makeHandler();
export const config={path:'/api/account'};
