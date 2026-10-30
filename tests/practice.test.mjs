import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { validateScenario, loadLibrary, buildSql } from '../scripts/build-practice-seed.mjs';
import { practiceConfig, buildPracticeEmail } from '../netlify/functions/lib/practice-email.mjs';
import { runPractice } from '../netlify/functions/scheduled-practice.mjs';
import { makeHandler as practiceHandler } from '../netlify/functions/practice.mjs';
import { makeHandler as eventsHandler, verifySendGrid } from '../netlify/functions/practice-events.mjs';
import { makeHandler as adminHandler } from '../netlify/functions/admin.mjs';

const origin = 'https://joinsafekeep.com';
const practiceOrigin = 'https://practice.joinsafekeep.com';
const token = 'ab'.repeat(24);
const env = { APP_ORIGIN: origin, PRACTICE_LINK_ORIGIN: practiceOrigin, PRACTICE_EMAIL_DOMAIN: 'notices.example-practice.com', PRACTICE_POSTAL_ADDRESS: 'Safekeep, 1 Main St, Springfield', EMAIL_FROM: 'hello@mail.joinsafekeep.com' };

test('the seed library is valid: 20 scenarios in each of email, text and phone, 40/40/20 difficulty mix, tells quoted word for word', () => {
 const library = loadLibrary();
 for (const format of ['email', 'text', 'phone']) {
  assert.equal(library[format].length, 20, format);
  for (const s of library[format]) assert.deepEqual(validateScenario(s, format), [], `${format}/${s.code}`);
  const easy = library[format].filter(s => s.difficulty <= 2).length, hard = library[format].filter(s => s.difficulty >= 4).length;
  assert.equal(easy, 8, format); assert.equal(hard, 4, format);
 }
 // Each scenario is one scam with a version per channel.
 assert.deepEqual(library.text.map(s => s.code).sort(), library.email.map(s => s.code).sort());
 assert.deepEqual(library.phone.map(s => s.code).sort(), library.email.map(s => s.code).sort());
 const sql = buildSql(library);
 assert.equal((sql.match(/'draft'/g) || []).length, 60, 'every version goes in as a draft');
 assert.ok(!/'published'/.test(sql));
});

test('text and phone rules: reserved reply words, length, and call scripts that offer press 1', () => {
 const lib = loadLibrary();
 assert.match(validateScenario({ ...lib.text[1], channel_variant: { reply_keywords: ['STOP'] } }, 'text').join(), /reply keywords cannot/);
 assert.match(validateScenario({ ...lib.text[0], content: 'x'.repeat(260) + ' {link}' }, 'text').join(), /two text messages/);
 const call = lib.phone[0];
 assert.match(validateScenario({ ...call, channel_variant: { script: { ...call.channel_variant.script, hook: 'Stay on the line.' } } }, 'phone').join(), /press 1/);
});

test('the library check catches a misquoted tell, a real brand and words coaching never uses', () => {
 const base = loadLibrary().email[0];
 assert.match(validateScenario({ ...base, tells: [{ quote: 'not in the message', note: 'x' }, base.tells[1]] }, 'email').join(), /word for word/);
 assert.match(validateScenario({ ...base, from_name: 'Amazon Delivery' }, 'email').join(), /real brand/);
 assert.match(validateScenario({ ...base, debrief: 'Lots of people fell for this.' }, 'email').join(), /we don't use/);
 assert.match(validateScenario({ ...base, content: base.content.replace('{link}', '') }, 'email').join(), /\{link\}/);
});

test('practice email: link, one-click stop header, footer shown by default and only on easy ones when allowed', () => {
 const row = { practice_id: 'p1', token, difficulty: 3, subject: 'Your parcel', content: 'Pay here: {link}\n\nThanks <b>', channel_variant: { from_name: 'Parcel Delivery Notice', from_local: 'delivery-notice' } };
 const config = practiceConfig(env);
 assert.deepEqual(config.missing, []);
 const email = buildPracticeEmail(row, config);
 assert.equal(email.from.email, 'delivery-notice@notices.example-practice.com');
 assert.equal(email.from.name, 'Parcel Delivery Notice');
 assert.ok(email.text.includes(`${practiceOrigin}/p/${token}`));
 assert.ok(email.text.includes('Safekeep practice message'), 'footer on by default until counsel signs off');
 assert.ok(email.text.includes('1 Main St'));
 assert.equal(email.headers['List-Unsubscribe'], `<${practiceOrigin}/api/practice?stop=${token}>`);
 assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
 assert.ok(email.html.includes('Thanks &lt;b&gt;'), 'content is escaped in HTML');
 assert.ok(!/<img/i.test(email.html), 'no tracking pixel');
 const easyOnly = practiceConfig({ ...env, PRACTICE_FOOTER: 'easy_only' });
 assert.ok(!buildPracticeEmail(row, easyOnly).text.includes('Safekeep practice message'));
 assert.ok(buildPracticeEmail({ ...row, difficulty: 2 }, easyOnly).text.includes('Safekeep practice message'));
 assert.ok(buildPracticeEmail(row, easyOnly).text.includes('To stop these emails'), 'the stop link is always there');
});

test('practice mail refuses to share a domain with account mail, and needs a postal address', () => {
 assert.match(practiceConfig({ ...env, PRACTICE_EMAIL_DOMAIN: 'mail.joinsafekeep.com' }).missing.join(), /different from the EMAIL_FROM/);
 assert.match(practiceConfig({ ...env, PRACTICE_POSTAL_ADDRESS: '' }).missing.join(), /PRACTICE_POSTAL_ADDRESS/);
});

function fakeAdmin(claimed = []) {
 const calls = [];
 return { calls, client: { rpc: async (name, args) => { calls.push({ name, args }); if (name === 'claim_due_practices') return { data: claimed, error: null }; if (name === 'plan_practices') return { data: 1, error: null }; return { data: { closed: 0 }, error: null }; } } };
}

test('the scheduler closes windows but plans and sends nothing until practice email is fully set up', async () => {
 const { calls, client } = fakeAdmin();
 const result = await runPractice({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', ...env }, makeClient: () => client, fetcher: async () => { throw new Error('no fetch'); } });
 assert.match(result.skipped, /SENDGRID_API_KEY.*PRACTICE_SENDING=on/);
 assert.deepEqual(calls.map(c => c.name), ['close_observations']);
});

test('the scheduler sends claimed rows with tracking off and marks each one sent or failed', async () => {
 const rows = [{ practice_id: 'p1', address: 'mom@example.com', token, difficulty: 1, subject: 'S', content: 'Go {link}', channel_variant: {}, idempotency_key: 'i1' },
  { practice_id: 'p2', address: 'dad@example.com', token: 'cd'.repeat(24), difficulty: 1, subject: 'S', content: 'Go {link}', channel_variant: {}, idempotency_key: 'i2' }];
 const { calls, client } = fakeAdmin(rows);
 const sent = [];
 const fetcher = async (url, init) => { const body = JSON.parse(init.body); sent.push(body); if (body.personalizations[0].to[0].email === 'dad@example.com') return new Response('{}', { status: 500 }); return new Response('', { status: 202, headers: { 'x-message-id': 'sg-1' } }); };
 const result = await runPractice({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_API_KEY: 'sg', PRACTICE_SENDING: 'on', ...env }, makeClient: () => client, fetcher });
 assert.deepEqual(result.email, { due: 2, sent: 1, failed: 1 });
 assert.deepEqual(result.channels, ['email'], 'text and calls stay off until Twilio is configured');
 assert.equal(sent[0].tracking_settings.click_tracking.enable, false);
 assert.equal(sent[0].tracking_settings.open_tracking.enable, false);
 assert.equal(sent[0].personalizations[0].custom_args.practice_id, 'p1');
 assert.deepEqual(calls.find(c => c.name === 'mark_practice_sent').args, { pid: 'p1', provider_id: 'sg-1' });
 const failed = calls.find(c => c.name === 'mark_practice_failed').args;
 assert.equal(failed.pid, 'p2'); assert.equal(failed.permanent, false, 'an API refusal never suppresses the address');
 assert.deepEqual(calls.find(c => c.name === 'claim_due_practices').args, { ch: 'email', lim: 25 });
});

function anonDb() {
 const calls = [];
 return { calls, makeClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); if (name === 'coaching_view') return { data: args.token === token ? { name: 'Parcel', result: 'engaged' } : null, error: null }; if (name === 'stop_by_token') return { data: { saved: true, channel: 'email' }, error: null }; if (name === 'coaching_share') return { data: { saved: true, shares_left: 2 }, error: null }; return { data: { correct: true, message: 'Yes.' }, error: null }; } }) };
}
const post = (body, from = practiceOrigin, url = 'https://practice.joinsafekeep.com/api/practice') => new Request(url, { method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('coaching API: opens by POST from either site, never by GET, and only with a well-formed token', async () => {
 const db = anonDb();
 const handler = practiceHandler({ env, makeClient: db.makeClient });
 assert.equal((await handler(new Request(`${practiceOrigin}/api/practice?t=${token}`))).status, 405);
 assert.deepEqual(await (await handler(post({ action: 'view', token }))).json(), { found: true, coaching: { name: 'Parcel', result: 'engaged' } });
 assert.equal((await (await handler(post({ action: 'view', token }, origin))).json()).found, true);
 assert.equal((await handler(post({ action: 'view', token }, 'https://evil.example'))).status, 403);
 assert.deepEqual(await (await handler(post({ action: 'view', token: 'zz' }))).json(), { found: false });
 assert.equal(db.calls.filter(c => c.name === 'coaching_view').length, 2);
 assert.equal((await handler(post({ action: 'answer', token, choice: 7 }))).status, 400);
 assert.equal((await (await handler(post({ action: 'share', token, to_email: 'kid@example.com' }))).json()).shares_left, 2);
});

test('one-click unsubscribe works from a mail client without an Origin header; the footer link stops too', async () => {
 const db = anonDb();
 const handler = practiceHandler({ env, makeClient: db.makeClient });
 const oneClick = new Request(`${practiceOrigin}/api/practice?stop=${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
 assert.deepEqual(await (await handler(oneClick)).json(), { stopped: true });
 assert.deepEqual(db.calls.at(-1), { name: 'stop_by_token', args: { token } });
 const page = await (await handler(post({ action: 'stop', token }))).json();
 assert.match(page.message, /won’t send you any more practice emails/);
});

test('SendGrid events: signature checked first, then delivered, bounce and spam reports map to the right calls', async () => {
 const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
 const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
 const pid = '11111111-1111-4111-8111-111111111111';
 const payload = JSON.stringify([{ event: 'delivered', practice_id: pid, sg_event_id: 'e1' }, { event: 'bounce', type: 'bounce', practice_id: pid, reason: '550 no such user' }, { event: 'bounce', type: 'blocked', practice_id: pid }, { event: 'spamreport', practice_id: pid }, { event: 'delivered', sg_event_id: 'not-ours' }]);
 const ts = String(Math.floor(Date.now() / 1000));
 const signature = sign('sha256', Buffer.from(ts + payload), privateKey).toString('base64');
 assert.equal(verifySendGrid({ publicKey: pub, signature, timestamp: ts, payload }), true);
 assert.equal(verifySendGrid({ publicKey: pub, signature, timestamp: ts, payload: payload + ' ' }), false);
 const calls = [];
 const handler = eventsHandler({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_WEBHOOK_PUBLIC_KEY: pub }, makeClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; } }) });
 const req = sig => new Request('https://joinsafekeep.com/api/practice/events', { method: 'POST', headers: { 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts }, body: payload });
 assert.equal((await handler(req('AAAA'))).status, 401);
 assert.equal(calls.length, 0);
 assert.equal((await handler(req(signature))).status, 200);
 assert.deepEqual(calls.map(c => c.name), ['mark_practice_delivered', 'mark_practice_failed', 'stop_by_practice']);
 assert.equal(calls[1].args.permanent, true);
});

function adminClient({ isAdmin }) {
 const calls = [];
 return { calls, createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', email: 'ian@example.com', email_confirmed_at: 'x' } }, error: null }) }, rpc: async (name, args) => { calls.push({ name, args }); if (name === 'am_i_admin') return { data: isAdmin, error: null }; return { data: name === 'admin_action' && args.action === 'queue' ? [] : { saved: true }, error: null }; } }) };
}

test('admin API: hidden from non-admins; approve and suppress go through admin_action', async () => {
 const nobody = adminClient({ isAdmin: false });
 assert.equal((await adminHandler({ env: { APP_ORIGIN: origin }, createClient: nobody.createClient })(new Request(`${origin}/api/admin`))).status, 404);
 const ian = adminClient({ isAdmin: true });
 const handler = adminHandler({ env: { APP_ORIGIN: origin }, createClient: ian.createClient });
 const state = await (await handler(new Request(`${origin}/api/admin`))).json();
 assert.equal(state.admin, true);
 const v = '22222222-2222-4222-8222-222222222222';
 await handler(post({ action: 'approve', version_id: v }, origin, `${origin}/api/admin`));
 assert.deepEqual(ian.calls.at(-1), { name: 'admin_action', args: { action: 'approve', payload: { version_id: v, note: '' } } });
 const bad = await handler(post({ action: 'edit', version_id: v, content: 'Hello {link}', tells: [{ quote: 'missing', note: 'n' }] }, origin, `${origin}/api/admin`));
 assert.equal(bad.status, 400);
 assert.equal((await handler(post({ action: 'approve', version_id: v }, 'https://evil.example', `${origin}/api/admin`))).status, 403);
});
