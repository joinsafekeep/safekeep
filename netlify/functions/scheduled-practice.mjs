import { createClient } from '@supabase/supabase-js';
import { practiceConfig, buildPracticeEmail, sendPracticeEmail } from './lib/practice-email.mjs';
import { twilioAuth, sendSms, placeCall } from './lib/twilio.mjs';

// Every ten minutes, with the service role:
//  1. close observation windows (72 hours after a send with nothing seen is "ignored it") and retire versions;
//  2. plan the next practice for anyone who has none waiting, on the channels that are switched on (caps, quiet
//     hours and selection rules are in plan_practices), and cancel anything planned on a channel that isn't;
//  3. for each channel, claim what is due; the database re-checks plan, consent, contact, pause and caps right
//     before each one and cancels anything that fails, so this function only ever sees rows that may be sent;
//  4. send: email through SendGrid from the practice domain, texts through the Twilio Messaging Service, calls from
//     Safekeep's Twilio number; then mark each sent or failed (one retry for a temporary failure, done by the database).
// A channel sends only when everything it needs is set and its switch is on (PRACTICE_SENDING, PRACTICE_TEXT,
// PRACTICE_CALLS), so a half-configured deploy sends nothing on it.
export function channelStatus(env) {
 const email = practiceConfig(env);
 if (!env.SENDGRID_API_KEY) email.missing.push('SENDGRID_API_KEY');
 if (env.PRACTICE_SENDING !== 'on') email.missing.push('PRACTICE_SENDING=on');
 const twilio = [...(!twilioAuth(env) || !env.TWILIO_ACCOUNT_SID ? ['TWILIO_ACCOUNT_SID and a Twilio key'] : []), ...(!env.TWILIO_AUTH_TOKEN ? ['TWILIO_AUTH_TOKEN (for webhooks)'] : [])];
 const text = [...twilio, ...(!env.TWILIO_MESSAGING_SERVICE_SID ? ['TWILIO_MESSAGING_SERVICE_SID'] : []), ...(!email.linkOrigin ? ['PRACTICE_LINK_ORIGIN'] : []), ...(env.PRACTICE_TEXT !== 'on' ? ['PRACTICE_TEXT=on'] : [])];
 const phone = [...twilio, ...(!env.TWILIO_VOICE_NUMBER ? ['TWILIO_VOICE_NUMBER'] : []), ...(env.PRACTICE_CALLS !== 'on' ? ['PRACTICE_CALLS=on'] : [])];
 return { email, missing: { email: email.missing, text, phone }, on: ['email', 'text', 'phone'].filter(c => !({ email: email.missing, text, phone }[c].length)) };
}

export function practiceText(row, { linkOrigin, footerAlways }) {
 const body = String(row.content || '').replaceAll('{link}', `${linkOrigin}/p/${row.token}`);
 // The same rule as email: the label shows on every practice until counsel agrees it can go at difficulty 3 and up.
 return footerAlways || row.difficulty <= 2 ? `${body}\n\nSafekeep practice. Reply STOP to stop.` : body;
}

export async function runPractice({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, limit = 25 } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const housekeeping = must(await admin.rpc('close_observations'));
 const status = channelStatus(env);
 if (!status.on.length) return { housekeeping, skipped: `No practice channel is sending. Email needs: ${status.missing.email.join(', ')}` };
 const cancelled = must(await admin.rpc('cancel_planned_outside', { channels: status.on }));
 const planned = must(await admin.rpc('plan_practices', { channels: status.on }));
 const site = (env.APP_ORIGIN || env.URL || 'https://joinsafekeep.com').replace(/\/$/, '');
 const results = {};
 for (const channel of status.on) {
  const due = must(await admin.rpc('claim_due_practices', { ch: channel, lim: limit })) || [];
  let sent = 0, failed = 0;
  for (const row of due) {
   let id;
   try {
    if (channel === 'email') id = await sendPracticeEmail({ apiKey: env.SENDGRID_API_KEY, to: row.address, email: buildPracticeEmail(row, status.email), practiceId: row.practice_id, idempotencyKey: row.idempotency_key, fetcher });
    if (channel === 'text') id = (await sendSms({ env, to: row.address, body: practiceText(row, status.email), statusCallback: `${site}/api/practice/sms-status?p=${row.practice_id}`, fetcher })).sid;
    if (channel === 'phone') id = (await placeCall({ env, to: row.address, extension: row.extension, url: `${site}/api/practice/voice?p=${row.practice_id}&step=start`, statusCallback: `${site}/api/practice/voice?p=${row.practice_id}&step=status`, fetcher })).sid;
   } catch (e) {
    await admin.rpc('mark_practice_failed', { pid: row.practice_id, reason: String(e?.message || e).slice(0, 200), permanent: false }); failed += 1;
    continue;
   }
   // Once the provider has it, it's sent: never mark it failed (that would send it again). If recording it fails, try
   // once more; a row still left queued is closed by the next claim without a second send.
   let r = await admin.rpc('mark_practice_sent', { pid: row.practice_id, provider_id: id || null });
   if (r.error) r = await admin.rpc('mark_practice_sent', { pid: row.practice_id, provider_id: id || null });
   sent += 1;
  }
  results[channel] = { due: due.length, sent, failed };
 }
 return { housekeeping, channels: status.on, cancelled, planned, ...results };
}

export default async () => {
 const result = await runPractice();
 console.log('practice', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '*/10 * * * *' };
