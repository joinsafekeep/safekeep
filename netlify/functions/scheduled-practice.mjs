import { createClient } from '@supabase/supabase-js';
import { practiceConfig, buildPracticeEmail, sendPracticeEmail } from './lib/practice-email.mjs';

// Every ten minutes, with the service role:
//  1. close observation windows (72 hours after a send with nothing seen is "ignored it") and retire versions;
//  2. plan the next practice for anyone who has none waiting (caps, quiet hours, selection rules in plan_practices);
//  3. claim what is due by email; the database re-checks plan, consent, contact, pause and caps right before each one
//     and cancels anything that fails, so this function only ever sees rows that may be sent;
//  4. send each through SendGrid from the practice domain, then mark it sent or failed (one retry for a temporary
//     failure, done by the database).
// Text and phone join in phases 6 and 7 by claiming their own channel.
export async function runPractice({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, limit = 25 } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const housekeeping = must(await admin.rpc('close_observations'));
 // Nothing is planned or sent until email practice is fully configured, so a half-set-up deploy can't send anything.
 const config = practiceConfig(env);
 if (!env.SENDGRID_API_KEY) config.missing.push('SENDGRID_API_KEY');
 if (env.PRACTICE_SENDING !== 'on') config.missing.push('PRACTICE_SENDING=on');
 if (config.missing.length) return { housekeeping, skipped: `Not sending practice email until these are set: ${config.missing.join(', ')}` };
 const planned = must(await admin.rpc('plan_practices'));
 const due = must(await admin.rpc('claim_due_practices', { ch: 'email', lim: limit })) || [];
 let sent = 0, failed = 0;
 for (const row of due) {
  let id;
  try {
   id = await sendPracticeEmail({ apiKey: env.SENDGRID_API_KEY, to: row.address, email: buildPracticeEmail(row, config), practiceId: row.practice_id, idempotencyKey: row.idempotency_key, fetcher });
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
 return { housekeeping, planned, due: due.length, sent, failed };
}

export default async () => {
 const result = await runPractice();
 console.log('practice', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '*/10 * * * *' };
