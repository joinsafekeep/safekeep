import { createClient } from '@supabase/supabase-js';
import { readTwilioWebhook, twiml, xml } from './lib/twilio.mjs';
import { classifyReply } from './lib/distress.mjs';

// Twilio webhooks for practice texts. Service role, because the sender is a phone network, not a signed-in person;
// every request must carry a valid Twilio signature.
//  /api/practice/sms         a text from a participant (the Messaging Service's incoming-message webhook)
//  /api/practice/sms-status  delivery reports for practice texts (?p=<practice id>, set when sending)
// Replies, per the PRD:
//  STOP and its synonyms   consent to practice texts withdrawn, queue cancelled; Twilio's Advanced Opt-Out confirms
//  REPORT                  spotted it; a short congratulatory reply with the coaching link
//  worried or confused     marked inconclusive, the reassurance below, and every admin emailed to follow up today
//  anything else           a practice opportunity; "You did nothing wrong" and the coaching link
const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)\W*$/i;
const ASKS_TO_STOP = /\b(stop|unsubscribe|leave me alone|don'?t (text|message|contact|call)|remove me|no more)\b/i;
const TWILIO_HANDLES = /^(start|unstop|yes start|help|info)\W*$/i;
export const MESSAGES = {
 report: link => `You spotted it. That was a Safekeep practice, and checking was exactly the right move. Here's what gave it away: ${link}`,
 reply: link => `That was a Safekeep practice. You did nothing wrong. Here is what to look for next time: ${link}`,
 distress: () => 'This is Safekeep, the scam-spotting practice you signed up for. That message was a practice, not a real one, and nothing has happened to your money or your information. You don\'t need to do anything. Someone from our team will check in with you today. Reply STOP any time to end practice texts.',
 distressStopped: () => 'This is Safekeep, the scam-spotting practice you signed up for. That message was a practice, not a real one, and nothing has happened to your money or your information. We\'ve stopped practice texts to this number. Someone from our team will check in with you today.',
 unknown: origin => `This is Safekeep. We couldn't match your message to a recent practice. If you're unsure about a message, don't reply to it, and call the number on your card or ask someone you trust. Your practice history is at ${origin}/account/`
};
const PERMANENT_SMS_ERRORS = new Set(['21211', '21612', '21614', '30005', '30006', '30004']);

export function makeHandler({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch } = {}) {
 return async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.TWILIO_AUTH_TOKEN) return new Response('Not configured', { status: 503 });
  const { ok, params, url } = await readTwilioWebhook(request, env);
  if (!ok) return new Response('Bad signature', { status: 403 });
  const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = r => { if (r.error) throw r.error; return r.data; };
  const origin = (env.PRACTICE_LINK_ORIGIN || env.APP_ORIGIN || 'https://joinsafekeep.com').replace(/\/$/, '');

  if (url.pathname.endsWith('/sms-status')) {
   const pid = url.searchParams.get('p') || '';
   if (!/^[0-9a-f-]{36}$/.test(pid)) return new Response(null, { status: 204 });
   const status = params.MessageStatus;
   if (status === 'delivered') must(await admin.rpc('mark_practice_delivered', { pid, provider_event: `${params.MessageSid}:delivered` }));
   else if (status === 'undelivered' || status === 'failed') {
    if (params.ErrorCode === '21610') must(await admin.rpc('stop_texts_from', { from_number: params.To }));
    else must(await admin.rpc('mark_practice_failed', { pid, reason: `text ${status} ${params.ErrorCode || ''}`.trim(), permanent: PERMANENT_SMS_ERRORS.has(String(params.ErrorCode)) }));
   }
   return new Response(null, { status: 204 });
  }

  const from = String(params.From || ''), body = String(params.Body || '').trim();
  if (STOP.test(body)) { must(await admin.rpc('stop_texts_from', { from_number: from })); return twiml(''); }
  if (TWILIO_HANDLES.test(body)) return twiml('');
  const practice = must(await admin.rpc('practice_for_text_reply', { from_number: from }))?.[0];
  if (!practice) return twiml(`<Message>${xml(MESSAGES.unknown(origin))}</Message>`);
  let kind = /^report\W*$/i.test(body) ? 'report' : null;
  if (!kind) kind = (await classifyReply({ text: body, replyKeywords: practice.reply_keywords, apiKey: env.ANTHROPIC_API_KEY, model: env.DISTRESS_MODEL || undefined, fetcher })) === 'distress' ? 'distress' : 'reply';
  const result = must(await admin.rpc('record_text_reply', { pid: practice.practice_id, kind, message_sid: params.MessageSid || null, reply_text: body.slice(0, 1000) }));
  // "Please stop texting me" isn't the bare STOP keyword, so the carrier won't opt the number out, but the person has
  // asked to stop: practice texts stop here too.
  if (kind === 'distress' && ASKS_TO_STOP.test(body)) {
   must(await admin.rpc('stop_texts_from', { from_number: from }));
   return twiml(`<Message>${xml(MESSAGES.distressStopped())}</Message>`);
  }
  const link = `${origin}/p/${result.token}`;
  return twiml(`<Message>${xml(kind === 'distress' ? MESSAGES.distress() : MESSAGES[kind](link))}</Message>`);
 };
}
export default makeHandler();
export const config = { path: ['/api/practice/sms', '/api/practice/sms-status'] };
