import { createClient } from '@supabase/supabase-js';
import { participantEmail, familyEmail, familyBlock, sponsorEmail } from './lib/report-email.mjs';

// Hourly: the monthly reports (PRD: Monthly performance tracking).
//  1. generate_due_reports() makes each report that is due: last month's, at 09:00 on the 1st in the participant's
//     time zone (active at least 14 days of it), or the welcome report after a new participant's first two practices;
//  2. the participant's email, and one for each person they chose to receive it, are queued in outbound_emails
//     (scheduled-email.mjs sends them);
//  3. a sponsor whom more than one participant chose gets one combined email: each participant's block waits in
//     report_rollups for six hours, so reports from other time zones can join, and then they go out together.
// Every number comes from practice_metrics(), the same function behind the account page and the admin view.
const ROLLUP_WAIT_MS = 6 * 3600000;
export async function runReports({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, now = () => new Date() } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const site = (env.APP_ORIGIN || 'https://joinsafekeep.com').replace(/\/$/, '');
 let feed = [];
 try { const r = await fetcher(`${site}/scam-alerts/alerts.json`); if (r.ok) feed = (await r.json()).alerts || []; } catch {}
 const alertsFor = report => {
  const start = report.kind === 'welcome' ? new Date(now().getTime() - 30 * 86400000) : new Date(`${report.month}T00:00:00Z`);
  const end = report.kind === 'welcome' ? now() : new Date(new Date(`${report.month}T00:00:00Z`).setUTCMonth(new Date(`${report.month}T00:00:00Z`).getUTCMonth() + 1));
  return feed.filter(a => { const d = new Date(`${a.published}T12:00:00Z`); return d >= start && d < end; });
 };
 const queue = rows => rows.length ? admin.from('outbound_emails').insert(rows).then(must) : null;

 const due = must(await admin.rpc('generate_due_reports')) || [];
 let familySent = 0, rolled = 0;
 for (const report of due) {
  const alerts = alertsFor(report);
  const mine = participantEmail({ report, name: report.participant_name, site, alerts });
  await queue([{ to_email: report.participant_email, subject: mine.subject, body: mine.text, html: mine.html, kind: 'report_participant' }]);
  must(await admin.rpc('mark_report_sent', { rid: report.report_id, who: 'participant' }));
  const family = must(await admin.rpc('report_family', { uid: report.participant_user_id })) || [];
  const name = report.participant_name || 'Your family member';
  const direct = [];
  for (const r of family) {
   if (r.is_sponsor) {
    const block = familyBlock({ report, name, site, token: report.web_token });
    must(await admin.from('report_rollups').insert({ to_email: r.email, month: report.month, participant_name: name, recipient_id: r.recipient_id, sig: r.sig, block_html: block.html, block_text: block.text }));
    rolled += 1;
   } else {
    const email = familyEmail({ report, name, readerName: r.name, site, token: report.web_token, alerts, recipient: r });
    direct.push({ to_email: r.email, subject: email.subject, body: email.text, html: email.html, kind: 'report_family' });
   }
  }
  await queue(direct); familySent += direct.length;
  must(await admin.rpc('mark_report_sent', { rid: report.report_id, who: 'family' }));
 }

 // Sponsor roll-ups whose first block has waited long enough.
 const waiting = must(await admin.from('report_rollups').select('id,to_email,month,participant_name,recipient_id,sig,block_html,block_text,created_at').is('sent_at', null).order('created_at')) || [];
 const groups = new Map();
 for (const row of waiting) { const key = `${row.to_email}|${row.month}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
 let sponsorSent = 0;
 for (const blocks of groups.values()) {
  if (now().getTime() - new Date(blocks[0].created_at).getTime() < ROLLUP_WAIT_MS) continue;
  const month = blocks[0].month;
  const email = sponsorEmail({ month, blocks, site, alerts: alertsFor({ kind: 'monthly', month }) });
  await queue([{ to_email: blocks[0].to_email, subject: email.subject, body: email.text, html: email.html, kind: 'report_sponsor' }]);
  must(await admin.from('report_rollups').update({ sent_at: now().toISOString() }).in('id', blocks.map(b => b.id)));
  sponsorSent += 1;
 }
 return { reports: due.length, family_emails: familySent, rollup_blocks: rolled, sponsor_emails: sponsorSent };
}

export default async () => {
 const result = await runReports();
 console.log('reports', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '@hourly' };
