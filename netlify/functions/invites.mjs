import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { defaults, validateRequest, jsonHeaders } from './lib/session.mjs';

// /api/invites: the two things the invite page does before anyone signs in.
//  GET  ?t=<token>          what the invitation says (sponsor's first name, invitee name and email, note, plan)
//  POST {action:'decline'}   "No thanks": frees the seat and tells the sponsor
// Both run as the anonymous role through two narrow database functions; accepting needs a signed-in, verified
// account and goes through /api/account. No service-role key here.
const TOKEN = /^[0-9a-f]{64}$/;
export function makeHandler({ env = process.env, makeClient = createSupabaseClient } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const origin = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!origin) return reply({ error: 'Invitations are not set up yet.' }, 503);
  try { validateRequest(request, new URL(origin).origin); } catch { return reply({ error: 'Request blocked.' }, 403); }
  const db = makeClient(env.SUPABASE_URL || defaults.url, env.SUPABASE_PUBLISHABLE_KEY || defaults.key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
   if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('t') || '';
    if (!TOKEN.test(token)) return reply({ found: false });
    const { data, error } = await db.rpc('invitation_by_token', { token });
    if (error) throw error;
    const inv = data?.[0];
    return reply(inv ? { found: true, invitation: inv } : { found: false });
   }
   const raw = await request.text();
   if (raw.length > 2048) return reply({ error: 'Request is too large.' }, 413);
   let body; try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid request.' }, 400); }
   if (body.action !== 'decline' || !TOKEN.test(body.token || '')) return reply({ error: 'Invalid request.' }, 400);
   const { data, error } = await db.rpc('decline_invitation', { token: body.token });
   if (error) throw error;
   return reply({ declined: !!data?.saved, message: data?.saved ? 'Thank you for letting us know. Nothing will be sent to you.' : 'This invitation has already been answered or has expired.' });
  } catch {
   return reply({ error: 'Unable to complete this request. Please try again.' }, 400);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/invites' };
