import { createClient } from '@supabase/supabase-js';
import { createPublicKey, verify } from 'node:crypto';

// /api/practice/events: SendGrid's signed Event Webhook for practice mail. Only events carrying our practice_id are
// acted on:
//  delivered            -> delivered
//  bounce, dropped      -> failed; the address is suppressed, and the participant (and a gifted seat's sponsor)
//                          are told practice by email has paused until they update it
//  blocked, deferred    -> nothing; SendGrid retries these itself
//  spamreport           -> treated as stop: consent for that address is withdrawn
// Service role, because the provider is not a signed-in person. The signature is checked before anything is read.
export function verifySendGrid({ publicKey, signature, timestamp, payload, now = Date.now() }) {
 if (!publicKey || !signature || !timestamp) return false;
 if (Math.abs(now / 1000 - Number(timestamp)) > 600) return false;
 try {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  return verify('sha256', Buffer.from(timestamp + payload), key, Buffer.from(signature, 'base64'));
 } catch { return false; }
}

export function makeHandler({ env = process.env, makeClient = createClient, now = () => Date.now() } = {}) {
 return async request => {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SENDGRID_WEBHOOK_PUBLIC_KEY) return reply({ error: 'Not configured' }, 503);
  const payload = await request.text();
  if (payload.length > 1_000_000) return reply({ error: 'Too large' }, 413);
  const ok = verifySendGrid({ publicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY, signature: request.headers.get('x-twilio-email-event-webhook-signature'), timestamp: request.headers.get('x-twilio-email-event-webhook-timestamp'), payload, now: now() });
  if (!ok) return reply({ error: 'Bad signature' }, 401);
  let events; try { events = JSON.parse(payload); } catch { return reply({ error: 'Bad payload' }, 400); }
  if (!Array.isArray(events)) return reply({ error: 'Bad payload' }, 400);
  const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const counts = {};
  for (const event of events) {
   const pid = event?.practice_id;
   if (!/^[0-9a-f-]{36}$/.test(String(pid || ''))) continue;
   let result = null;
   if (event.event === 'delivered') result = await admin.rpc('mark_practice_delivered', { pid, provider_event: String(event.sg_event_id || '').slice(0, 100) || null });
   else if (event.event === 'bounce' && event.type !== 'blocked') result = await admin.rpc('mark_practice_failed', { pid, reason: `bounce: ${String(event.reason || '').slice(0, 150)}`, permanent: true });
   else if (event.event === 'dropped') result = await admin.rpc('mark_practice_failed', { pid, reason: `dropped: ${String(event.reason || '').slice(0, 150)}`, permanent: /bounc|invalid|unsubscribe|spam/i.test(String(event.reason || '')) });
   else if (event.event === 'spamreport') result = await admin.rpc('stop_by_practice', { pid, source: 'email-spam-report' });
   else continue;
   // Fail the whole request so SendGrid redelivers the batch; every call above is safe to repeat.
   if (result?.error) return reply({ error: 'Try again' }, 500);
   counts[event.event] = (counts[event.event] || 0) + 1;
  }
  return reply({ received: events.length, ...counts });
 };
}
export default makeHandler();
export const config = { path: '/api/practice/events' };
