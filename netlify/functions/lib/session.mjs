import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';

// The cookie and origin discipline shared by every request-path function: HttpOnly, Secure, SameSite=Lax session
// cookies managed on the server, and a matching Origin plus JSON content type on every write. Mirrors account.mjs.
export const defaults = {
 url: 'https://iybcbztvofqihvqhqfoo.supabase.co',
 key: 'sb_publishable_zYE3IWYDB4KSj9UZkbLVBg__SDs-7hr'
};
export function validateRequest(request, origin) {
 if (!['GET','POST'].includes(request.method)) throw new Error('Method not allowed');
 if (request.method === 'POST' && (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json'))) throw new Error('Request blocked');
}
export function jsonHeaders() {
 return new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
}
export function sessionClient({ request, headers, env, createClient = createServerClient }) {
 const origin = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
 const secure = !(env.COOKIE_SECURE==='false' && new URL(origin).hostname==='localhost');
 return createClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, {
  cookieOptions: {name:secure?'__Host-safekeep-auth':'safekeep-auth',path:'/',httpOnly:true,secure,sameSite:'lax'},
  cookies: {
   getAll:()=>parseCookieHeader(request.headers.get('cookie') || ''),
   setAll:(cookies, cacheHeaders)=>{
    for (const {name,value,options} of cookies) headers.append('Set-Cookie',serializeCookieHeader(name,value,{...options,httpOnly:true,secure,sameSite:'lax',path:'/'}));
    if(cacheHeaders) for(const [name,value] of Object.entries(cacheHeaders)) headers.set(name,value);
   }
  }
 });
}
