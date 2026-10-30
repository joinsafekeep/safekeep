import { createClient } from '@supabase/supabase-js';
import { readTwilioWebhook, twiml, xml, sendSms } from './lib/twilio.mjs';

// /api/practice/voice: TwiML for practice calls and their status callbacks (?p=<practice id>&step=...). Service role,
// Twilio signature required. The call, per the PRD:
//  start     voicemail or fax: hang up, nothing left behind. A person: the opening and the hook ("press 1...").
//  answer1   1 or "yes": the hook taken, so the reveal. 9: stop practice calls. Another key or "no": spotted it, and
//            the reveal anyway. Silence: the pressure line, once.
//  answer2   the same, except that staying on through the pressure line counts as taking the hook.
//  reveal    a different voice says plainly that it was a Safekeep practice and nothing happened, names the warning
//            signs and one thing to do next time, then offers a text with the coaching link (if they agreed to texts)
//            and "press 9 to stop".
//  link      sends that text.
//  status    the call ended: settles the outcome, counts unanswered calls, and emails a reveal to anyone who
//            answered but hung up before hearing one, so nobody is left unsure.
// Calls are never recorded; only events are kept.
const YES = /\b(yes|yeah|yep|okay|ok|sure|please|agent|connect|go ahead|help)\b/i;
const NO = /\b(no|nope|not interested|scam|fake|hang up|goodbye|stop|leave me)\b/i;

export function makeHandler({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch } = {}) {
 const voice = env.PRACTICE_CALL_VOICE || 'Polly.Matthew';
 const revealVoice = env.PRACTICE_REVEAL_VOICE || 'Polly.Joanna';
 return async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.TWILIO_AUTH_TOKEN) return new Response('Not configured', { status: 503 });
  const { ok, params, url } = await readTwilioWebhook(request, env);
  if (!ok) return new Response('Bad signature', { status: 403 });
  const pid = url.searchParams.get('p') || '', step = url.searchParams.get('step') || 'start';
  if (!/^[0-9a-f-]{36}$/.test(pid)) return twiml('<Hangup/>');
  const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = r => { if (r.error) throw r.error; return r.data; };
  const event = (name, extra = {}) => admin.rpc('record_call_event', { pid, event: name, call_sid: params.CallSid || null, duration: null, answered_by: null, ...extra }).then(must);
  const site = (env.APP_ORIGIN || env.URL || 'https://joinsafekeep.com').replace(/\/$/, '');
  const linkOrigin = (env.PRACTICE_LINK_ORIGIN || site).replace(/\/$/, '');
  const action = next => xml(`${site}/api/practice/voice?p=${pid}&step=${next}`);
  const say = (text, v = voice) => `<Say voice="${v}">${xml(text)}</Say>`;

  if (step === 'status') {
   const status = params.CallStatus;
   const duration = status === 'completed' ? Number(params.CallDuration || 0) : null;
   await event('ended', { duration, answered_by: params.AnsweredBy || null });
   return new Response(null, { status: 204 });
  }

  const call = must(await admin.rpc('call_script', { pid }));
  if (!call?.script) return twiml('<Hangup/>');
  const s = call.script;

  const reveal = async how => {
   await event('revealed');
   const opener = how === 'refused'
    ? 'This is Safekeep. That was a practice call, and you handled it well. Nothing has happened to your money or your information.'
    : 'This is Safekeep. That was a practice call, not a real one, and you did nothing wrong. Nothing has happened to your money or your information.';
   const signs = (call.tells || []).slice(0, 3).map((t, i) => `${['First', 'Second', 'Third'][i]}: ${t.note}`).join(' ');
   const next = call.next_steps?.[0] ? `Next time, you might say to yourself: ${call.next_steps[0]}` : '';
   const offer = call.can_text ? 'To get a text with these warning signs and what to do next time, press 1. To stop practice calls, press 9. Or you can simply hang up.' : 'You can see this call, with its warning signs, on your Safekeep account page. To stop practice calls, press 9. Or you can simply hang up.';
   return twiml(`${say(opener, revealVoice)}<Pause length="1"/>${say(`Here is what gave it away. ${signs}`, revealVoice)}${next ? say(next, revealVoice) : ''}<Gather input="dtmf" numDigits="1" timeout="6" action="${action('after')}">${say(offer, revealVoice)}</Gather>${say('Thank you for practising with Safekeep. Goodbye.', revealVoice)}<Hangup/>`);
  };
  const stop = async () => { await event('stop'); return twiml(`${say('All right. You won\'t get any more practice calls from Safekeep. Your account and any other practice you chose stay as they are. Goodbye.', revealVoice)}<Hangup/>`); };
  const gather = (next, text) => `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" hints="yes, no" action="${action(next)}" actionOnEmptyResult="true">${text}</Gather>`;

  if (step === 'start') {
   if (/^(machine|fax)/.test(params.AnsweredBy || '')) return twiml('<Hangup/>');
   if (call.revealed) return twiml('<Hangup/>');
   await event('answered');
   return twiml(gather('answer1', `${say(s.opening)}<Pause length="1"/>${say(s.hook)}`));
  }
  if (step === 'answer1' || step === 'answer2') {
   const digits = params.Digits || '', speech = params.SpeechResult || '';
   if (digits === '9') return stop();
   if (digits === '1' || (!digits && YES.test(speech) && !NO.test(speech))) { await event('hook'); return reveal('hook'); }
   if (digits || NO.test(speech)) { await event('refused'); return reveal('refused'); }
   if (step === 'answer1') return twiml(gather('answer2', say(s.pressure)));
   await event('hook'); // stayed on through the pressure line
   return reveal('hook');
  }
  if (step === 'after') {
   if (params.Digits === '9') return stop();
   if (params.Digits === '1' && call.can_text && call.text_to) {
    const { token } = await event('link');
    try { await sendSms({ env, to: call.text_to, body: `Safekeep: here are the warning signs from today's practice call, and what to do next time: ${linkOrigin}/p/${token}`, fetcher }); }
    catch { return twiml(`${say('Sorry, the text didn\'t go through. You can find this call on your Safekeep account page. Goodbye.', revealVoice)}<Hangup/>`); }
    return twiml(`${say('Sent. Take care. Goodbye.', revealVoice)}<Hangup/>`);
   }
   return twiml(`${say('Thank you for practising with Safekeep. Goodbye.', revealVoice)}<Hangup/>`);
  }
  return twiml('<Hangup/>');
 };
}
export default makeHandler();
export const config = { path: '/api/practice/voice' };
