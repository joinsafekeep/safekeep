import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, pageText } from '../netlify/functions/lib/alert-sources.mjs';
import { checkAlert } from '../netlify/functions/lib/alert-check.mjs';
import { buildPrompt, parseDraft, weekOf } from '../netlify/functions/lib/alert-draft.mjs';
import { renderAlertEmail } from '../netlify/functions/lib/alert-email.mjs';
import { runAlertDraft, authorized } from '../netlify/functions/alerts-draft-background.mjs';
import { queuePublishedAlerts } from '../netlify/functions/deploy-succeeded.mjs';
import { runAlertSend } from '../netlify/functions/scheduled-alert-send.mjs';
import { makeHandler as alertsHandler } from '../netlify/functions/alerts.mjs';

const SRC = { url: 'https://www.ic3.gov/PSA/2026/PSA261102', title: 'Scammers pose as utility companies', text: 'On November 2, 2026, the FBI warned that scammers posing as utility companies threatened shut-offs. Victims reported losses of $1,200 on average, and 40% paid with gift cards.' };
const DESCRIPTION = 'Scammers are calling as your utility company and threatening to cut off power today unless you pay by gift card. How to spot it and what to do about it.';

function draft({ body = '', meta = {} } = {}) {
 const m = { title: "This Week's Scam Alert: Utility Shut-off Scams (November 2, 2026)", seo_title: 'Utility Shut-off Scams: FBI Warning | Safekeep', description: DESCRIPTION, summary: 'Short summary.', keywords: 'utility scam', type: 'Weekly alert', published: '2026-11-02', updated: '2026-11-02', draft: 'true', ...meta };
 return `---\n${Object.entries(m).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n**Quick answer:** The FBI warned on November 2, 2026 about utility shut-off calls ([FBI IC3](${SRC.url})).\n\n## What is it?\n\nPeople reported losing $1,200 on average, and 40% paid with gift cards ([FBI IC3](${SRC.url})). Report it at [ReportFraud](https://reportfraud.ftc.gov/) or call 1-833-372-8311.\n${body}\n## Frequently asked questions\n\n### Is it real?\n\nNo.\n\n## Sources\n\n- [FBI IC3](${SRC.url})\n`;
}

test('feeds: RSS and Atom items with links and dates; page text keeps the main content', () => {
 const rss = parseFeed('<rss><channel><item><title><![CDATA[Scam &amp; you]]></title><link>https://a.gov/1</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item></channel></rss>');
 assert.deepEqual(rss[0], { title: 'Scam & you', url: 'https://a.gov/1', published: '2026-11-02T10:00:00.000Z', summary: 'Hi' });
 const atom = parseFeed('<feed><entry><title>T</title><link href="https://b.gov/2"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>');
 assert.equal(atom[0].url, 'https://b.gov/2');
 assert.equal(pageText('<html><nav>Menu</nav><main><h1>Title</h1><p>Body text.</p></main><footer>F</footer></html>'), 'Title\nBody text.');
});

test('the check passes a sourced draft and allows the standard reporting sites and hotline', () => {
 assert.deepEqual(checkAlert(draft(), [SRC], { today: new Date('2026-11-02') }), []);
});

test('the check catches made-up numbers, uncited pages, length limits, style slips and a missing draft flag', () => {
 const problems = checkAlert(draft({ body: '\nAbout 75% of people navigate this fine. It’s not about money, it’s about trust. See [this](https://example.com/story).\n', meta: { description: 'Too short.', seo_title: 'x'.repeat(61), draft: 'false' } }), [SRC], { today: new Date('2026-11-02') });
 const all = problems.join('\n');
 assert.match(all, /number 75%/);
 assert.match(all, /example\.com\/story/);
 assert.match(all, /description is 10 characters/);
 assert.match(all, /seo_title is 61/);
 assert.match(all, /"navigate"/);
 assert.match(all, /contrast flip/);
 assert.match(all, /draft must be true/);
 assert.match(checkAlert(draft({ body: '\nIt started on March 3.\n' }), [SRC]).join(), /date march 3/i);
});

test('the prompt carries the sources and, on a redraft, the problems; the reply is split into alert and practice', () => {
 const p = buildPrompt({ style: 'STYLE', keywords: 'KW', frontMatterSpec: 'SPEC', recent: [{ slug: 'weekly-2026-10-26', excerpt: 'Last week' }], sources: [SRC], date: '2026-11-02', problems: ['The number 75% is not in a source.'], previous: 'old' });
 assert.match(p.system, /STYLE/); assert.match(p.user, /PSA261102/); assert.match(p.user, /The number 75%/); assert.match(p.user, /weekly-2026-10-26/);
 const parsed = parseDraft('<alert>\n```markdown\n---\ntitle: x\n---\nBody\n```\n</alert>\n<practice>[{"format":"text"}]</practice>');
 assert.equal(parsed.markdown, '---\ntitle: x\n---\nBody\n');
 assert.equal(parsed.practice.length, 1);
 assert.equal(weekOf(new Date('2026-11-04T15:00:00Z')), '2026-11-02');
});

test('the alert email uses the quick answer, warning signs and what to do, with a per-person unsubscribe', () => {
 const feed = JSON.parse(readFileSync(new URL('../scam-alerts/alerts.json', import.meta.url), 'utf8'));
 const email = renderAlertEmail(feed.alerts[0]);
 assert.equal(email.subject, 'Scam Alert: Midterm Election Scams');
 assert.match(email.html, /warning signs/i); assert.match(email.html, /What should you do/);
 assert.match(email.html, /href="-unsubscribe-"/); assert.match(email.text, /Unsubscribe: -unsubscribe-/);
 assert.match(email.html, /href="https:\/\/joinsafekeep\.com\/scam-alerts\/weekly-2026-10-19"/);
 assert.ok(!/<button/.test(email.html));
});

// A tiny stand-in for the Supabase client: enough of the query builder for the alert job.
function fakeDb(tables = {}) {
 const calls = [];
 const from = name => {
  const t = (tables[name] ||= []);
  let filter = () => true, op = 'select', values = null;
  const q = {
   select() { return q; }, eq(k, v) { const f = filter; filter = r => f(r) && r[k] === v; return q; }, is(k, v) { const f = filter; filter = r => f(r) && (r[k] ?? null) === v; return q; },
   in(k, vs) { const f = filter; filter = r => f(r) && vs.includes(r[k]); return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
   insert(v) { op = 'insert'; values = v; return q; }, update(v) { op = 'update'; values = v; return q; }, upsert(v) { op = 'upsert'; values = v; return q; },
   maybeSingle() { return q.then(r => ({ ...r, data: Array.isArray(r.data) ? r.data[0] || null : r.data })); },
   single() { return q.then(r => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); },
   then(resolve) {
    calls.push({ name, op, values });
    if (op === 'insert' || op === 'upsert') { const row = { id: `${name}-${t.length + 1}`, ...values }; t.push(row); return resolve({ data: [row], error: null }); }
    if (op === 'update') { t.filter(filter).forEach(r => Object.assign(r, values)); return resolve({ data: null, error: null }); }
    return resolve({ data: t.filter(filter), error: null });
   }
  };
  return q;
 };
 return { calls, tables, client: { from, rpc: async (n, a) => { calls.push({ name: n, op: 'rpc', values: a }); return { data: [], error: null }; } } };
}

test('the alert job: collects, drafts, checks, redrafts once, opens a PR with draft: true and queues practice drafts', async () => {
 const db = fakeDb();
 const practice = [{ format: 'email', code: 'utility-shutoff', name: 'Utility shut-off', category: 'utility', difficulty: 2, from_name: 'Utility Billing', from_local: 'billing', subject: 'Final notice', content: 'Pay today by gift card: {link}', tells: [{ quote: 'Pay today', note: 'A rush.' }, { quote: 'gift card', note: 'No utility takes them.' }], next_steps: ['I will call the number on my bill.', 'I will delete it.'], learning_objective: 'x', debrief: 'y', question: { prompt: 'Q?', choices: ['a', 'b', 'c'], correct: 1, affirm: 'Yes.', gently: 'Close.' } },
  { format: 'text', code: 'bad', name: 'Chase alert', category: 'bank', difficulty: 2, content: 'Chase: your card is locked', tells: [], next_steps: [], question: null }];
 let claudeCalls = 0; const github = [];
 const fetcher = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://www.ic3.gov/PSA/RSS') return new Response(`<rss><item><title>${SRC.title}</title><link>${SRC.url}</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></rss>`);
  if (url === SRC.url) return new Response(`<html><main>${SRC.text}</main></html>`);
  if (url.startsWith('https://api.anthropic.com/')) {
   claudeCalls += 1;
   const body = JSON.parse(init.body);
   assert.match(body.messages[0].content, /PSA261102/);
   const md = claudeCalls === 1 ? draft({ body: '\nAbout 75% of people.\n' }) : draft();
   if (claudeCalls === 2) assert.match(body.messages[0].content, /75%/);
   return Response.json({ content: [{ type: 'text', text: `<alert>\n${md}</alert>\n<practice>${JSON.stringify(practice)}</practice>` }] });
  }
  if (url.startsWith('https://api.github.com/')) {
   github.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
   if (url.includes('/contents/content/STYLE.md')) return Response.json({ content: Buffer.from('style').toString('base64') });
   if (url.includes('/contents/README.txt')) return Response.json({ content: Buffer.from('x\nSCAM ALERTS spec').toString('base64') });
   if (url.endsWith('/contents/content/scam-alerts?ref=main')) return Response.json([{ name: 'weekly-2026-10-19.md' }, { name: 'guide.md' }]);
   if (url.includes('/contents/content/scam-alerts/weekly-2026-10-19.md?ref=main')) return Response.json({ content: Buffer.from('title: Old\n**Quick answer:** old').toString('base64') });
   if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'abc' } });
   if (url.endsWith('/pulls') && init.method === 'POST') return Response.json({ html_url: 'https://github.com/joinsafekeep/safekeep/pull/99' });
   if (init.method === 'POST' || init.method === 'PUT') return Response.json({});
   if (url.includes('/pulls?')) return Response.json([]);
   return new Response('', { status: 404 });
  }
  return new Response('', { status: 404 });
 };
 const env = { SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'g' };
 // Only the IC3 feed answers; the rest fail and are listed, not fatal.
 db.tables.source_items = [];
 const result = await runAlertDraft({ env, makeClient: () => db.client, fetcher, now: () => new Date('2026-11-02T11:00:00Z') });
 assert.equal(claudeCalls, 2, 'one redraft after the check failed');
 assert.deepEqual(result.problems, []);
 assert.equal(result.pr_url, 'https://github.com/joinsafekeep/safekeep/pull/99');
 const put = github.find(g => g.method === 'PUT');
 assert.match(put.url, /content\/scam-alerts\/weekly-2026-11-02\.md$/);
 assert.match(Buffer.from(put.body.content, 'base64').toString(), /draft: true/);
 assert.equal(put.body.branch, 'alert/weekly-2026-11-02');
 const pr = github.find(g => g.url.endsWith('/pulls') && g.method === 'POST');
 assert.match(pr.body.body, /automated check passed/); assert.match(pr.body.body, /Utility shut-off \(email, difficulty 2\)/); assert.match(pr.body.body, /Chase alert/);
 const version = db.tables.practice_scam_versions[0];
 assert.equal(version.status, 'draft'); assert.equal(version.generated_by, 'model');
 assert.equal(db.tables.practice_scam_versions.length, 1, 'the one naming a real bank was not queued');
 assert.equal(db.tables.alerts[0].status, 'in_review');
 assert.equal(db.tables.source_items[0].used_in_alert_id, db.tables.alerts[0].id);
 // Running again the same week does nothing.
 assert.match((await runAlertDraft({ env, makeClient: () => db.client, fetcher, now: () => new Date('2026-11-02T12:00:00Z') })).skipped, /already in_review/);
});

test('the alert job is only startable with the shared secret', () => {
 const req = h => new Request('https://x/', { method: 'POST', headers: h });
 assert.equal(authorized(req({ 'x-safekeep-job': 's'.repeat(32) }), 's'.repeat(32)), true);
 assert.equal(authorized(req({ 'x-safekeep-job': 't'.repeat(32) }), 's'.repeat(32)), false);
 assert.equal(authorized(req({}), ''), false);
});

test('after a production deploy, alerts from the last week are queued; previews and old alerts are not', async () => {
 const calls = [];
 const client = { rpc: async (n, a) => { calls.push(a); return { data: 'sending', error: null }; } };
 const feed = { alerts: [{ slug: 'weekly-2026-11-02', title: 'This Week’s Scam Alert: X (November 2, 2026)', published: '2026-11-02', url: 'https://joinsafekeep.com/scam-alerts/weekly-2026-11-02', quick_answer: { html: 'q', text: 'q' } }, { slug: 'weekly-2026-10-19', title: 'Old', published: '2026-10-19', url: 'u' }] };
 const fetcher = async () => Response.json(feed);
 assert.match((await queuePublishedAlerts({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k' }, context: 'deploy-preview', makeClient: () => client, fetcher })).skipped, /not production/);
 const result = await queuePublishedAlerts({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k' }, context: 'production', makeClient: () => client, fetcher, now: () => new Date('2026-11-03T12:00:00Z') });
 assert.deepEqual(result.queued, ['weekly-2026-11-02: sending']);
 assert.equal(calls[0].subject, 'Scam Alert: X');
});

test('sending: batches with a personal unsubscribe link each, then finishes when nobody is left', async () => {
 const rpcs = []; let round = 0; const sent = [];
 const client = {
  from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle: async () => ({ data: { id: 'a1', slug: 'weekly-2026-11-02', email_subject: 'S', email_html: '<p>-unsubscribe-</p>', email_text: 't' }, error: null }) }),
  rpc: async (n, a) => { rpcs.push({ n, a }); if (n === 'claim_alert_recipients') return { data: round++ === 0 ? [{ email: 'a@x.com', kind: 'member', sig: 'aa' }, { email: 'b@x.com', kind: 'free', sig: 'bb' }] : [], error: null }; return { data: null, error: null }; }
 };
 const fetcher = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('', { status: 202 }); };
 const result = await runAlertSend({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_API_KEY: 's', EMAIL_FROM: 'hello@mail.joinsafekeep.com', ALERTS_POSTAL_ADDRESS: 'Safekeep, 1 Main St', APP_ORIGIN: 'https://joinsafekeep.com' }, makeClient: () => client, fetcher });
 assert.deepEqual(result, { slug: 'weekly-2026-11-02', sent: 2, failed: 0, finished: true });
 assert.equal(sent[0].personalizations.length, 2);
 assert.equal(sent[0].personalizations[1].substitutions['-unsubscribe-'], 'https://joinsafekeep.com/scam-alerts/subscribe/?u=b%40x.com&s=bb');
 assert.equal(sent[0].personalizations[0].headers['List-Unsubscribe'], '<https://joinsafekeep.com/api/alerts?u=a%40x.com&s=aa>');
 assert.equal(sent[0].from.email, 'hello@mail.joinsafekeep.com');
 assert.ok(rpcs.some(r => r.n === 'mark_alert_batch' && r.a.ok === true));
 assert.ok(rpcs.some(r => r.n === 'finish_alert'));
});

test('alerts API: sign-up from the site only, a bot field is ignored, one-click unsubscribe works without an Origin', async () => {
 const rpcs = [];
 const handler = alertsHandler({ env: { APP_ORIGIN: 'https://joinsafekeep.com' }, makeClient: () => ({ rpc: async (n, a) => { rpcs.push({ n, a }); return { data: { saved: true }, error: null }; } }) });
 const post = (body, origin = 'https://joinsafekeep.com', url = 'https://joinsafekeep.com/api/alerts') => new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
 assert.equal((await handler(post({ action: 'subscribe', email: 'a@b.com' }, 'https://evil.example'))).status, 403);
 await handler(post({ action: 'subscribe', email: 'bot@b.com', website: 'spam' }));
 assert.equal(rpcs.length, 0);
 assert.match((await (await handler(post({ action: 'subscribe', email: 'Me@B.com' }))).json()).message, /Check your email/);
 assert.deepEqual(rpcs[0], { n: 'alerts_subscribe', a: { addr: 'me@b.com', src: 'site' } });
 const oneClick = new Request('https://joinsafekeep.com/api/alerts?u=me%40b.com&s=abc', { method: 'POST', body: 'List-Unsubscribe=One-Click' });
 assert.deepEqual(await (await handler(oneClick)).json(), { unsubscribed: true });
 assert.deepEqual(rpcs.at(-1), { n: 'alerts_unsubscribe', a: { addr: 'me@b.com', sig: 'abc' } });
});
