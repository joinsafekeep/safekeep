import { createClient } from '@supabase/supabase-js';
import { unsubscribeUrl, oneClickUrl } from './lib/alert-email.mjs';

// Every ten minutes: send any queued weekly alert, a few hundred recipients per run. Each address is claimed in
// alert_sends before its batch goes out, so a retry never mails anyone twice. Sent from the account mail domain
// (EMAIL_FROM), never the practice domain. Members and the free list get the same email; each has a one-click
// unsubscribe that turns off the alert only.
const BATCH = 400;
export async function runAlertSend({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, batches = 2 } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM || !env.ALERTS_POSTAL_ADDRESS) return { skipped: 'Set SENDGRID_API_KEY, EMAIL_FROM and ALERTS_POSTAL_ADDRESS to send alerts' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const origin = (env.APP_ORIGIN || 'https://joinsafekeep.com').replace(/\/$/, '');
 const alert = must(await admin.from('alerts').select('id,slug,email_subject,email_html,email_text').eq('status', 'sending').order('published_at').limit(1).maybeSingle());
 if (!alert) return { idle: true };
 let sent = 0, failed = 0;
 for (let b = 0; b < batches; b++) {
  const people = must(await admin.rpc('claim_alert_recipients', { aid: alert.id, lim: BATCH })) || [];
  if (!people.length) { must(await admin.rpc('finish_alert', { aid: alert.id })); return { slug: alert.slug, sent, failed, finished: true }; }
  const body = {
   personalizations: people.map(p => ({
    to: [{ email: p.email }],
    substitutions: { '-unsubscribe-': unsubscribeUrl(origin, p.email, p.sig), '-footer-': env.ALERTS_POSTAL_ADDRESS },
    headers: { 'List-Unsubscribe': `<${oneClickUrl(origin, p.email, p.sig)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
   })),
   from: { email: env.EMAIL_FROM, name: 'Safekeep Scam Alert' }, subject: alert.email_subject, categories: ['alert'],
   content: [{ type: 'text/plain', value: alert.email_text }, { type: 'text/html', value: alert.email_html }],
   tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } }
  };
  // SendGrid takes up to 1,000 personalizations per request; each person only sees their own address.
  const response = await fetcher('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  must(await admin.rpc('mark_alert_batch', { aid: alert.id, addresses: people.map(p => p.email), ok: response.ok }));
  if (response.ok) sent += people.length; else failed += people.length;
 }
 return { slug: alert.slug, sent, failed };
}

export default async () => {
 const result = await runAlertSend();
 console.log('alert-send', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '*/10 * * * *' };
