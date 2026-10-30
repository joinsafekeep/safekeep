import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { defaults, jsonHeaders } from './lib/session.mjs';

// /api/practice: what the coaching page at /p/<token> does, with no login. The token in the link is the only
// credential, and the database functions behind each action accept nothing else. Runs as the anonymous role; no
// service-role key here.
//  POST {action:'view', token}                         open the page (first open records the click)
//  POST {action:'answer', token, choice}                the one question (0-2, or null to skip)
//  POST {action:'share', token, to_email, to_name, from_name}   send the page to a family member
//  POST {action:'stop_info', token}                     the footer's stop page: which channel, recording nothing
//  POST {action:'stop', token}                          stop practice by this channel (the footer's link)
//  POST ?stop=<token>  List-Unsubscribe=One-Click       the mail client's one-click unsubscribe (RFC 8058)
// The page opens with a POST, not a GET, so link scanners that fetch URLs in incoming mail don't count as a click.
const TOKEN = /^[0-9a-f]{48}$/;
export function makeHandler({ env = process.env, makeClient = createSupabaseClient } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const origins = [env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL, env.PRACTICE_LINK_ORIGIN].filter(Boolean).map(o => new URL(o).origin);
  if (!origins.length) return reply({ error: 'Practice is not set up yet.' }, 503);
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  const db = makeClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = r => { if (r.error) throw r.error; return r.data; };
  try {
   const oneClick = new URL(request.url).searchParams.get('stop');
   if (oneClick !== null) {
    // Mail clients post this without an Origin header; the token is what authorizes it.
    if (!TOKEN.test(oneClick)) return reply({ error: 'Invalid request.' }, 400);
    must(await db.rpc('stop_by_token', { token: oneClick }));
    return reply({ stopped: true });
   }
   if (!origins.includes(request.headers.get('origin')) || !request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Request blocked.' }, 403);
   const raw = await request.text();
   if (raw.length > 4096) return reply({ error: 'Request is too large.' }, 413);
   let body; try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid request.' }, 400); }
   const token = String(body.token || '');
   if (!TOKEN.test(token)) return reply({ found: false });
   if (body.action === 'view') {
    const coaching = must(await db.rpc('coaching_view', { token }));
    return reply(coaching ? { found: true, coaching } : { found: false });
   }
   if (body.action === 'stop_info') {
    const info = must(await db.rpc('stop_info', { token }));
    return reply(info ? { found: true, ...info } : { found: false });
   }
   if (body.action === 'answer') {
    const choice = body.choice === null ? null : Number(body.choice);
    if (choice !== null && ![0, 1, 2].includes(choice)) return reply({ error: 'Choose one of the three answers.' }, 400);
    const result = must(await db.rpc('coaching_answer', { token, choice }));
    return reply(result ? { ...result } : { found: false });
   }
   if (body.action === 'share') {
    const result = must(await db.rpc('coaching_share', { token, to_email: String(body.to_email || '').slice(0, 254), to_name: String(body.to_name || '').slice(0, 80), from_name: String(body.from_name || '').slice(0, 80) }));
    return reply(result?.saved ? { message: 'Sent. They’ll get an email with a link to this page.', shares_left: result.shares_left } : { found: false });
   }
   if (body.action === 'stop') {
    const result = must(await db.rpc('stop_by_token', { token }));
    const channel = { email: 'emails', text: 'text messages', phone: 'calls' }[result?.channel] || 'messages';
    return reply(result?.saved ? { stopped: true, message: `Done. We won’t send you any more practice ${channel} there. You can turn practice back on from your account page whenever you like.` } : { found: false });
   }
   return reply({ error: 'Invalid request.' }, 400);
  } catch (error) {
   const message = String(error?.message || '');
   const safe = ['You’ve shared this one', "You've shared this one", 'Enter their email address', 'Choose one of the three'];
   return reply({ error: safe.some(p => message.startsWith(p)) ? message : 'Unable to complete this request. Please try again.' }, 400);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/practice' };
