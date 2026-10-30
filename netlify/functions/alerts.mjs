import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { defaults, jsonHeaders } from './lib/session.mjs';

// /api/alerts: the weekly Scam Alert email list, for anyone (no login, anonymous role, no service-role key).
//  POST {action:'subscribe', email, website}   free list sign-up; a confirmation email goes out (double opt-in)
//  POST {action:'confirm', token}              the link in that email
//  POST {action:'unsubscribe', email, sig}     the link at the bottom of every alert (members and free list)
//  POST ?u=<email>&s=<sig>                     the mail client's one-click unsubscribe (RFC 8058)
// Unsubscribing only stops the alert; practice messages carry on. The answer to subscribe is the same whether or not
// the address is already on the list.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function makeHandler({ env = process.env, makeClient = createSupabaseClient } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  const site = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!site) return reply({ error: 'Not set up yet.' }, 503);
  const db = makeClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = r => { if (r.error) throw r.error; return r.data; };
  try {
   const params = new URL(request.url).searchParams;
   if (params.get('u') !== null) {
    const result = must(await db.rpc('alerts_unsubscribe', { addr: String(params.get('u')).slice(0, 254), sig: String(params.get('s') || '').slice(0, 64) }));
    return reply({ unsubscribed: !!result?.saved }, result?.saved ? 200 : 400);
   }
   if (request.headers.get('origin') !== new URL(site).origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Request blocked.' }, 403);
   const raw = await request.text();
   if (raw.length > 2048) return reply({ error: 'Request is too large.' }, 413);
   let body; try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid request.' }, 400); }
   if (body.action === 'subscribe') {
    if (body.website) return reply({ message: 'Check your email to confirm.' }); // the hidden field a person never fills in
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return reply({ error: 'Enter a valid email address.' }, 400);
    must(await db.rpc('alerts_subscribe', { addr: email, src: String(body.source || 'site').slice(0, 40) }));
    return reply({ message: 'Thank you. Check your email and open the link to confirm, and the alert will start next week.' });
   }
   if (body.action === 'confirm') {
    if (!/^[0-9a-f]{48}$/.test(String(body.token || ''))) return reply({ confirmed: false });
    const result = must(await db.rpc('alerts_confirm', { token: body.token }));
    return reply({ confirmed: !!result?.saved });
   }
   if (body.action === 'unsubscribe') {
    const result = must(await db.rpc('alerts_unsubscribe', { addr: String(body.email || '').slice(0, 254), sig: String(body.sig || '').slice(0, 64) }));
    return reply({ unsubscribed: !!result?.saved });
   }
   return reply({ error: 'Invalid request.' }, 400);
  } catch (error) {
   const message = String(error?.message || '');
   return reply({ error: message.startsWith('Enter a valid email') ? message : 'Unable to complete this request. Please try again.' }, 400);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/alerts' };
