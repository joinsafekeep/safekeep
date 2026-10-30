import { validateRequest, jsonHeaders, sessionClient } from './lib/session.mjs';

// /api/admin: the review queue and delivery view behind /admin/. Same sign-in and cookie as /api/account; every
// action goes through admin_action, which checks admin_users in the database, so this function adds no authority.
//  GET                                   queue, library counts, recent deliveries (404 for anyone who isn't an admin)
//  POST {action:'approve'|'reject', version_id, note?}
//  POST {action:'edit', version_id, subject?, content?, difficulty?, debrief?, tells?, next_steps?, question?}
//  POST {action:'suppress_contact', contact_id}
export function makeHandler({ env = process.env, createClient } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const origin = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!origin) return reply({ error: 'Not configured.' }, 503);
  try { validateRequest(request, new URL(origin).origin); } catch { return reply({ error: 'Request blocked.' }, 403); }
  const client = sessionClient({ request, headers, env, ...(createClient ? { createClient } : {}) });
  const must = r => { if (r.error) throw r.error; return r.data; };
  try {
   const { data: { user } = {}, error } = await client.auth.getUser();
   if (error || !user || !user.email_confirmed_at) return reply({ signed_in: false }, 401);
   if (!must(await client.rpc('am_i_admin'))) return reply({ error: 'Not found.' }, 404);
   if (request.method === 'GET') {
    const [queue, library, deliveries] = await Promise.all(['queue', 'library', 'deliveries'].map(action => client.rpc('admin_action', { action, payload: {} })));
    return reply({ admin: true, email: user.email, queue: must(queue), library: must(library), deliveries: must(deliveries) });
   }
   const raw = await request.text();
   if (raw.length > 32768) return reply({ error: 'Request is too large.' }, 413);
   let body; try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid request.' }, 400); }
   const id = /^[0-9a-f-]{36}$/;
   if (['approve', 'reject'].includes(body.action) && id.test(body.version_id || '')) {
    must(await client.rpc('admin_action', { action: body.action, payload: { version_id: body.version_id, note: String(body.note || '').slice(0, 500) } }));
    return reply({ message: body.action === 'approve' ? 'Published. It can be sent from the next planning run.' : 'Rejected.' });
   }
   if (body.action === 'edit' && id.test(body.version_id || '')) {
    const payload = { version_id: body.version_id };
    for (const k of ['subject', 'content', 'debrief']) if (typeof body[k] === 'string') payload[k] = body[k].slice(0, 8000);
    if (Number.isInteger(body.difficulty) && body.difficulty >= 1 && body.difficulty <= 5) payload.difficulty = body.difficulty;
    if (Array.isArray(body.tells)) payload.tells = body.tells.slice(0, 4).map(t => ({ quote: String(t?.quote || '').slice(0, 300), note: String(t?.note || '').slice(0, 300) }));
    if (Array.isArray(body.next_steps)) payload.next_steps = body.next_steps.slice(0, 3).map(s => String(s).slice(0, 300));
    if (body.question && typeof body.question === 'object') payload.question = body.question;
    if (payload.tells && payload.content !== undefined && payload.tells.some(t => !payload.content.includes(t.quote))) return reply({ error: 'Each warning sign has to quote the message word for word.' }, 400);
    const result = must(await client.rpc('admin_action', { action: 'edit', payload }));
    return reply({ message: 'Saved as a new draft. Approve it to publish.', version_id: result?.version_id });
   }
   if (body.action === 'suppress_contact' && id.test(body.contact_id || '')) {
    must(await client.rpc('admin_action', { action: 'suppress_contact', payload: { contact_id: body.contact_id } }));
    return reply({ message: 'Contact suppressed. Nothing more will be sent to it.' });
   }
   return reply({ error: 'Invalid request.' }, 400);
  } catch (error) {
   const message = String(error?.message || '');
   return reply({ error: ['Draft not found', 'Version not found', 'Admins only'].some(p => message.startsWith(p)) ? message : 'Unable to complete this request.' }, 400);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/admin' };
