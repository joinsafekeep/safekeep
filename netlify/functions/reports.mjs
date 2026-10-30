import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { defaults, jsonHeaders } from './lib/session.mjs';

// /api/reports: the family side of the monthly report, with no login (anonymous role, no service-role key).
//  POST {action:'view', token}             the family web version of one report: counts and categories only
//  POST {action:'unsubscribe', rid, sig}   stop getting someone's report, from the link in the email
const TOKEN = /^[0-9a-f]{48}$/, UUID = /^[0-9a-f-]{36}$/;
export function makeHandler({ env = process.env, makeClient = createSupabaseClient } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  const site = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!site) return reply({ error: 'Not set up yet.' }, 503);
  if (request.headers.get('origin') !== new URL(site).origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Request blocked.' }, 403);
  const raw = await request.text();
  if (raw.length > 1024) return reply({ error: 'Request is too large.' }, 413);
  let body; try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid request.' }, 400); }
  const db = makeClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
   if (body.action === 'view') {
    if (!TOKEN.test(String(body.token || ''))) return reply({ found: false });
    const { data, error } = await db.rpc('report_by_token', { token: body.token });
    if (error) throw error;
    return reply(data ? { found: true, report: data } : { found: false });
   }
   if (body.action === 'unsubscribe') {
    if (!UUID.test(String(body.rid || ''))) return reply({ saved: false });
    const { data, error } = await db.rpc('report_unsubscribe', { rid: body.rid, sig: String(body.sig || '').slice(0, 64) });
    if (error) throw error;
    return reply({ saved: !!data?.saved });
   }
   return reply({ error: 'Invalid request.' }, 400);
  } catch { return reply({ error: 'Unable to complete this request. Please try again.' }, 400); }
 };
}
export default makeHandler();
export const config = { path: '/api/reports' };
