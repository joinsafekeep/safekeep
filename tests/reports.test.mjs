import test from 'node:test';
import assert from 'node:assert/strict';
import { participantReport, familyReport } from '../practice/report.js';
import { participantEmail, familyEmail, sponsorEmail, familyBlock, wordCount } from '../netlify/functions/lib/report-email.mjs';
import { runReports } from '../netlify/functions/scheduled-reports.mjs';
import { makeHandler as reportsHandler } from '../netlify/functions/reports.mjs';

const METRICS = { received: 5, by_channel: { email: 1, text: 3, phone: 1 }, spotted: 3, ignored: 1, pending: 0, inconclusive: 0, opportunities: [{ practice_id: 'p1', category: 'delivery', name: 'Parcel redelivery fee', channel: 'text', coached: true }], coached: 1, weak_spots: ['delivery'], streak_months: 0, last_month: { received: 4, spotted: 2, opportunities: 1 } };
const REPORT = { report_id: 'r1', participant_user_id: 'u1', kind: 'monthly', month: '2026-10-01', metrics: METRICS, web_token: 'ab'.repeat(24), participant_email: 'mom@example.com', participant_name: 'Margaret' };
const SITE = 'https://joinsafekeep.com';

test('report wording: the PRD measures, no scores or grades, and nothing the style guide rules out', () => {
 const mine = participantReport(METRICS).paragraphs.join(' ');
 assert.match(mine, /received five practice messages: one email, three texts and one call/);
 assert.match(mine, /You spotted three of them/); assert.match(mine, /You ignored one, which is a fine response too/);
 assert.match(mine, /One was a practice opportunity/); assert.match(mine, /You finished the coaching on it/);
 assert.match(mine, /delivery and parcel messages/);
 const theirs = familyReport(METRICS, 'Margaret').paragraphs.join(' ');
 assert.match(theirs, /This month Margaret received five practice messages/);
 assert.ok(!theirs.includes('Parcel redelivery fee'), 'family never see which message it was');
 for (const text of [mine, theirs]) {
  assert.ok(!/%|\bscore\b|\bgrade\b|\bfail|fell for|victim/i.test(text), text);
 }
 assert.match(participantReport({ ...METRICS, opportunities: [], spotted: 5, ignored: 0, weak_spots: [], streak_months: 3 }).paragraphs.join(' '), /spotted all five.*three months in a row/s);
});

test('report emails: under 400 words, a button to the web version, new scams this month, and a stop link for family', () => {
 const alerts = [{ title: 'This Week’s Scam Alert: Election Scams (October 19, 2026)', url: `${SITE}/scam-alerts/weekly-2026-10-19`, quick_answer: { text: 'Election scams use a real candidate’s name.' }, published: '2026-10-19' }];
 const mine = participantEmail({ report: REPORT, name: 'Margaret', site: SITE, alerts });
 assert.equal(mine.subject, 'Your Safekeep report for October 2026');
 assert.ok(wordCount(mine.html) < 400, `${wordCount(mine.html)} words`);
 assert.match(mine.html, /href="https:\/\/joinsafekeep\.com\/account\/#reports"/); assert.match(mine.html, /Election Scams/); assert.match(mine.html, /Parcel redelivery fee/);
 const theirs = familyEmail({ report: REPORT, name: 'Margaret', readerName: 'Ruth', site: SITE, token: REPORT.web_token, alerts, recipient: { recipient_id: 'f2', sig: 'cafe' } });
 assert.match(theirs.html, /href="https:\/\/joinsafekeep\.com\/r\/abab/); assert.match(theirs.html, /\/r\/\?u=f2&amp;s=cafe/);
 assert.ok(!theirs.html.includes('Parcel redelivery fee'));
 const block = familyBlock({ report: REPORT, name: 'Margaret', site: SITE, token: 'x' });
 const both = sponsorEmail({ month: '2026-10-01', site: SITE, alerts, blocks: [{ participant_name: 'Margaret', recipient_id: 'f1', sig: 'aa', ...{ block_html: block.html, block_text: block.text } }, { participant_name: 'Walter', recipient_id: 'f3', sig: 'bb', block_html: '<p>W</p>', block_text: 'W' }] });
 assert.match(both.html, /for Margaret and Walter/); assert.match(both.html, /Stop getting Walter’s report/);
});

test('the report job: participant email, a direct copy for each reader, and sponsor copies combined after the wait', async () => {
 const inserted = [], rollups = [], rpcs = [];
 let clock = new Date('2026-11-01T15:00:00Z');
 const db = {
  rpc: async (name, args) => {
   rpcs.push(name);
   if (name === 'generate_due_reports') return { data: rpcs.filter(n => n === name).length === 1 ? [REPORT, { ...REPORT, report_id: 'r2', participant_user_id: 'u2', participant_name: 'Walter', participant_email: 'dad@example.com' }] : [], error: null };
   if (name === 'report_family') return { data: [{ recipient_id: `f-${args.uid}`, name: 'Ian', email: 'ian@example.com', sig: 'aa', is_sponsor: true }, ...(args.uid === 'u1' ? [{ recipient_id: 'f2', name: 'Ruth', email: 'ruth@example.com', sig: 'bb', is_sponsor: false }] : [])], error: null };
   return { data: null, error: null };
  },
  from: table => ({
   insert: rows => { (table === 'outbound_emails' ? inserted : rollups).push(...[].concat(rows).map(r => ({ id: `${table}-${inserted.length + rollups.length}`, created_at: clock.toISOString(), ...r }))); return Promise.resolve({ data: null, error: null }); },
   select() { return this; }, is() { return this; }, order() { return Promise.resolve({ data: rollups.filter(r => !r.sent_at), error: null }); },
   update: values => ({ in: (k, ids) => { rollups.filter(r => ids.includes(r.id)).forEach(r => Object.assign(r, values)); return Promise.resolve({ data: null, error: null }); } })
  })
 };
 const fetcher = async () => Response.json({ alerts: [] });
 const first = await runReports({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', APP_ORIGIN: SITE }, makeClient: () => db, fetcher, now: () => clock });
 assert.deepEqual(first, { reports: 2, family_emails: 1, rollup_blocks: 2, sponsor_emails: 0 });
 assert.deepEqual(inserted.map(e => [e.kind, e.to_email]), [['report_participant', 'mom@example.com'], ['report_family', 'ruth@example.com'], ['report_participant', 'dad@example.com']]);
 clock = new Date('2026-11-01T22:00:00Z');
 const later = await runReports({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', APP_ORIGIN: SITE }, makeClient: () => db, fetcher, now: () => clock });
 assert.equal(later.sponsor_emails, 1);
 const combined = inserted.at(-1);
 assert.equal(combined.kind, 'report_sponsor'); assert.equal(combined.to_email, 'ian@example.com'); assert.match(combined.html, /Margaret and Walter/);
 assert.equal((await runReports({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', APP_ORIGIN: SITE }, makeClient: () => db, fetcher, now: () => clock })).sponsor_emails, 0, 'sent once');
});

test('reports API: the family view by token and the stop link, from the site only', async () => {
 const rpcs = [];
 const handler = reportsHandler({ env: { APP_ORIGIN: SITE }, makeClient: () => ({ rpc: async (n, a) => { rpcs.push({ n, a }); return { data: n === 'report_by_token' ? { name: 'Margaret' } : { saved: true }, error: null }; } }) });
 const post = (body, origin = SITE) => new Request(`${SITE}/api/reports`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
 assert.equal((await handler(post({ action: 'view', token: 'ab'.repeat(24) }, 'https://evil.example'))).status, 403);
 assert.deepEqual(await (await handler(post({ action: 'view', token: 'short' }))).json(), { found: false });
 assert.deepEqual(await (await handler(post({ action: 'view', token: 'ab'.repeat(24) }))).json(), { found: true, report: { name: 'Margaret' } });
 assert.deepEqual(await (await handler(post({ action: 'unsubscribe', rid: 'f2222222-2222-4222-8222-222222222222', sig: 'cafe' }))).json(), { saved: true });
 assert.deepEqual(rpcs.at(-1), { n: 'report_unsubscribe', a: { rid: 'f2222222-2222-4222-8222-222222222222', sig: 'cafe' } });
});
