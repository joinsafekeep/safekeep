import { createClient } from '@supabase/supabase-js';
import { renderAlertEmail } from './lib/alert-email.mjs';

// Runs when a deploy finishes (Netlify event function, named for the event). After a production deploy it reads the
// alerts feed the build wrote (/scam-alerts/alerts.json) and queues the email for any weekly alert published in the
// last seven days that hasn't been sent; scheduled-alert-send.mjs does the sending. Merging the alert's PR is what
// triggers the deploy, so merging is what sends it. queue_alert never queues the same alert twice.
export async function queuePublishedAlerts({ env = process.env, context, makeClient = createClient, fetcher = globalThis.fetch, now = () => new Date() } = {}) {
 if (context !== 'production') return { skipped: `not production (${context || 'unknown'})` };
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const site = (env.APP_ORIGIN || env.URL || 'https://joinsafekeep.com').replace(/\/$/, '');
 const response = await fetcher(`${site}/scam-alerts/alerts.json`, { cache: 'no-store' });
 if (!response.ok) return { skipped: `alerts.json ${response.status}` };
 const { alerts = [] } = await response.json();
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const cutoff = now().getTime() - 7 * 86400000;
 const queued = [];
 for (const alert of alerts) {
  if (new Date(`${alert.published}T12:00:00Z`).getTime() < cutoff) continue;
  const email = renderAlertEmail(alert);
  const { data, error } = await admin.rpc('queue_alert', { alert_slug: alert.slug, alert_title: alert.title, published: alert.published, subject: email.subject, html: email.html, plain: email.text });
  if (error) throw error;
  queued.push(`${alert.slug}: ${data}`);
 }
 return { queued };
}

export default async request => {
 let context = process.env.CONTEXT;
 try { const body = await request.json(); context = body?.payload?.context || context; } catch {}
 const result = await queuePublishedAlerts({ context });
 console.log('deploy-succeeded', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
