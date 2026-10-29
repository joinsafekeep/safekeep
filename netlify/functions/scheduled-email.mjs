import { createClient } from '@supabase/supabase-js';

// Every ten minutes: send whatever is waiting in outbound_emails. This is the only function that holds the email
// provider's key. SendGrid is the provider docs/accounts.md names as available; the send() call is the one place to
// change if Postmark or Resend is chosen instead. Rows are marked sent or failed; nothing is retried automatically,
// so a failure is visible in the table rather than looping.
export async function sendWithSendGrid({ apiKey, from, to, subject, body, fetcher = globalThis.fetch }) {
 const response = await fetcher('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: 'Safekeep' }, subject, content: [{ type: 'text/plain', value: body }] })
 });
 if (!response.ok) throw new Error(`SendGrid ${response.status}`);
}

export async function runSender({ env = process.env, now = () => new Date(), makeClient = createClient, fetcher = globalThis.fetch, limit = 50 } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) return { skipped: 'SENDGRID_API_KEY or EMAIL_FROM is not set; emails wait in outbound_emails' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const { data: pending, error } = await admin.from('outbound_emails').select('id,to_email,subject,body').is('sent_at', null).is('failed_at', null).order('created_at').limit(limit);
 if (error) throw error;
 let sent = 0, failed = 0;
 for (const row of pending || []) {
  try {
   await sendWithSendGrid({ apiKey: env.SENDGRID_API_KEY, from: env.EMAIL_FROM, to: row.to_email, subject: row.subject, body: row.body, fetcher });
   await admin.from('outbound_emails').update({ sent_at: now().toISOString() }).eq('id', row.id); sent += 1;
  } catch (e) {
   await admin.from('outbound_emails').update({ failed_at: now().toISOString(), failure: String(e?.message || e).slice(0, 200) }).eq('id', row.id); failed += 1;
  }
 }
 return { pending: (pending || []).length, sent, failed };
}

export default async () => {
 const result = await runSender();
 console.log('email-sender', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '*/10 * * * *' };
