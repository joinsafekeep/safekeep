import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeHandler as webhookHandler, verifyStripeSignature, subscriptionFields, handleEvent } from '../netlify/functions/billing-webhook.mjs';
import { makeHandler as portalHandler } from '../netlify/functions/billing.mjs';
import { runSender } from '../netlify/functions/scheduled-email.mjs';

const secret = 'whsec_test';
const origin = 'https://joinsafekeep.com';
const NOW = new Date('2026-10-29T20:00:00Z');
const sign = (payload, t = Math.floor(NOW.getTime() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const USER = '11111111-1111-4111-8111-111111111111';

// An in-memory stand-in for the service-role client: tables as arrays, a tiny query builder, rpc and auth.admin.
function fakeAdmin(seed = {}) {
 const tables = { webhook_events: [], subscriptions: [], subscription_members: [], outbound_emails: [], price_plans: [], ...seed };
 const rpcCalls = [];
 const from = table => {
  const rows = tables[table]; let filters = [], order = null, lim = null, pendingInsert = null, pendingUpdate = null, upsertOpts = null;
  const matches = r => filters.every(f => f(r));
  const b = {
   select: () => b, eq: (k, v) => { filters.push(r => r[k] === v); return b; }, is: (k, v) => { filters.push(r => r[k] === v || (v === null && r[k] == null)); return b; },
   in: (k, vs) => { filters.push(r => vs.includes(r[k])); return b; }, order: (k, o) => { order = { k, asc: o?.ascending !== false }; return b; }, limit: n => { lim = n; return b; },
   insert: row => { pendingInsert = row; return b; }, update: row => { pendingUpdate = row; return b; }, upsert: (row, opts) => { pendingInsert = row; upsertOpts = opts; return b; },
   maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: r.error }; }, single: async () => { const r = run(); return { data: r.data[0] || null, error: r.error }; },
   then: ok => ok(run())
  };
  function run() {
   if (pendingInsert) {
    const list = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
    for (const row of list) {
     if (table === 'webhook_events' && rows.some(r => r.provider_event_id === row.provider_event_id)) return { data: null, error: { code: '23505' } };
     if (upsertOpts && rows.some(r => r.subscription_id === row.subscription_id && r.user_id === row.user_id)) continue;
     rows.push({ id: `${table}-${rows.length + 1}`, created_at: NOW.toISOString(), ...row });
    }
    return { data: list.map(() => rows[rows.length - 1]), error: null };
   }
   if (pendingUpdate) { const hit = rows.filter(matches); for (const r of hit) Object.assign(r, pendingUpdate); return { data: hit, error: null }; }
   let out = rows.filter(matches);
   if (order) out = [...out].sort((a, c) => (a[order.k] < c[order.k] ? -1 : 1) * (order.asc ? 1 : -1));
   if (lim) out = out.slice(0, lim);
   return { data: out, error: null };
  }
  return b;
 };
 return { tables, rpcCalls, from, rpc: async (name, args) => { rpcCalls.push({ name, args }); if (name === 'end_subscription') { const sub = tables.subscriptions.find(s => s.id === args.sid); sub.ended_at = args.ended; } return { data: { ended: true }, error: null }; },
  auth: { admin: { getUserById: async id => ({ data: { user: id === USER ? { id, email: 'sponsor@example.com' } : null } }) } } };
}
const stripeSub = (over = {}) => ({ id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_family_annual' }, current_period_end: 1793000000 }] }, cancel_at: null, canceled_at: null, ended_at: null, ...over });
const event = (type, object, id = 'evt_' + type) => JSON.stringify({ id, type, created: 1761768000, data: { object } });
const post = (payload, header = sign(payload)) => new Request(origin + '/api/billing/webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
const env = { STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: 'sk_test', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const stripeApi = subs => async url => ({ ok: true, json: async () => subs[url.split('/').pop()] });

test('signature verification accepts a fresh signed payload and rejects tampering, stale timestamps and bad secrets', () => {
 const payload = '{"id":"evt_1"}';
 assert.equal(verifyStripeSignature(sign(payload), payload, secret, () => NOW.getTime()), true);
 assert.equal(verifyStripeSignature(sign(payload), payload + ' ', secret, () => NOW.getTime()), false);
 assert.equal(verifyStripeSignature(sign(payload), payload, 'other', () => NOW.getTime()), false);
 assert.equal(verifyStripeSignature(sign(payload, Math.floor(NOW.getTime() / 1000) - 600), payload, secret, () => NOW.getTime()), false);
 assert.equal(verifyStripeSignature(null, payload, secret), false);
});
test('subscription fields map period end from either the subscription or its item', () => {
 const a = subscriptionFields(stripeSub(), 'now'); assert.equal(a.current_period_end, '2026-10-26T07:33:20.000Z'); assert.equal(a.price_id, 'price_family_annual'); assert.equal(a.status, 'active');
 const b = subscriptionFields(stripeSub({ current_period_end: 1794000000, status: 'weird' }), 'now'); assert.equal(b.current_period_end, '2026-11-06T21:20:00.000Z'); assert.equal(b.status, 'incomplete');
});
test('unsigned, unconfigured and non-POST requests are refused before anything is read', async () => {
 const admin = fakeAdmin();
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW });
 assert.equal((await handler(post(event('invoice.paid', {}), 't=1,v1=bad'))).status, 400);
 assert.equal((await handler(new Request(origin + '/api/billing/webhook'))).status, 405);
 assert.equal((await webhookHandler({ env: {}, makeClient: () => admin })(post(event('invoice.paid', {})))).status, 503);
 assert.equal(admin.tables.webhook_events.length, 0);
});
test('a Payment Link checkout with the account id creates the plan and the sponsor seat; an old session id is skipped', async () => {
 const admin = fakeAdmin({ price_plans: [{ price_id: 'price_family_annual', plan: 'family', billing: 'annual', seats: 4 }] });
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW, fetcher: stripeApi({ sub_1: stripeSub() }) });
 const r = await handler(post(event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: USER })));
 assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.status, 'active');
 const sub = admin.tables.subscriptions[0]; assert.equal(sub.sponsor_user_id, USER); assert.equal(sub.seats, 4); assert.equal(sub.plan, 'family'); assert.equal(sub.stripe_subscription_id, 'sub_1');
 assert.deepEqual(admin.tables.subscription_members.map(m => [m.user_id, m.role, m.status]), [[USER, 'sponsor', 'active']]);
 const legacy = await handler(post(event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_2', customer: 'cus_2', client_reference_id: '5ed537a4-d50f-4b1c-a6a3-f0fdae3e0a09' }, 'evt_legacy')));
 assert.match((await legacy.json()).skipped, /not an account/); assert.equal(admin.tables.subscriptions.length, 1);
});
test('the same event delivered twice is applied once', async () => {
 const admin = fakeAdmin();
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW, fetcher: stripeApi({ sub_1: stripeSub() }) });
 const payload = event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: USER });
 await handler(post(payload)); const again = await handler(post(payload));
 assert.equal((await again.json()).duplicate, true); assert.equal(admin.tables.subscriptions.length, 1); assert.equal(admin.tables.webhook_events.length, 1);
});
test('cancel at period end keeps the plan active with cancel_at set; deletion ends it through end_subscription', async () => {
 const admin = fakeAdmin({ subscriptions: [{ id: 'row-1', sponsor_user_id: USER, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', ended_at: null }] });
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW });
 await handler(post(event('customer.subscription.updated', stripeSub({ cancel_at: 1795000000 }), 'evt_u1')));
 assert.equal(admin.tables.subscriptions[0].status, 'active'); assert.equal(admin.tables.subscriptions[0].cancel_at, '2026-11-18T11:06:40.000Z'); assert.equal(admin.rpcCalls.length, 0);
 const r = await handler(post(event('customer.subscription.deleted', stripeSub({ status: 'canceled', ended_at: 1795000000 }), 'evt_d1')));
 assert.equal((await r.json()).ended, true); assert.equal(admin.tables.subscriptions[0].status, 'canceled');
 assert.deepEqual(admin.rpcCalls, [{ name: 'end_subscription', args: { sid: 'row-1', ended: '2026-11-18T11:06:40.000Z' } }]);
 // A late duplicate 'updated' with status canceled does not end it twice.
 await handler(post(event('customer.subscription.updated', stripeSub({ status: 'canceled', ended_at: 1795000000 }), 'evt_u2')));
 assert.equal(admin.rpcCalls.length, 1);
});
test('a subscription event for an unknown customer with no account is skipped, not stored', async () => {
 const admin = fakeAdmin();
 const result = await handleEvent(JSON.parse(event('customer.subscription.updated', stripeSub({ id: 'sub_x', customer: 'cus_x' }))), { admin, env, now: () => NOW });
 assert.match(result.skipped, /no account/); assert.equal(admin.tables.subscriptions.length, 0);
});
test('the first failed payment emails the sponsor once and marks the plan past due; paying clears it', async () => {
 const admin = fakeAdmin({ subscriptions: [{ id: 'row-1', sponsor_user_id: USER, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', past_due_since: null }] });
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW });
 await handler(post(event('invoice.payment_failed', { subscription: 'sub_1', customer: 'cus_1', attempt_count: 1 }, 'evt_f1')));
 await handler(post(event('invoice.payment_failed', { subscription: 'sub_1', customer: 'cus_1', attempt_count: 2 }, 'evt_f2')));
 assert.equal(admin.tables.subscriptions[0].status, 'past_due'); assert.equal(admin.tables.subscriptions[0].past_due_since, NOW.toISOString());
 assert.equal(admin.tables.outbound_emails.length, 1); assert.equal(admin.tables.outbound_emails[0].to_email, 'sponsor@example.com'); assert.equal(admin.tables.outbound_emails[0].kind, 'payment_failed');
 await handler(post(event('invoice.paid', { subscription: 'sub_1', customer: 'cus_1' }, 'evt_p1')));
 assert.equal(admin.tables.subscriptions[0].status, 'active'); assert.equal(admin.tables.subscriptions[0].past_due_since, null);
});
test('a refund stamps refunded_at on the customer’s latest plan', async () => {
 const admin = fakeAdmin({ subscriptions: [{ id: 'row-1', sponsor_user_id: USER, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', refunded_at: null, created_at: '2026-01-01' }] });
 const handler = webhookHandler({ env, makeClient: () => admin, now: () => NOW });
 await handler(post(event('charge.refunded', { customer: 'cus_1' })));
 assert.equal(admin.tables.subscriptions[0].refunded_at, NOW.toISOString());
});
test('the portal session is created for the sponsor’s own customer and returns to the account page', async () => {
 const calls = [];
 const fetcher = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => ({ url: 'https://billing.stripe.com/session/abc' }) }; };
 const client = { auth: { getUser: async () => ({ data: { user: { id: USER, email_confirmed_at: 'yes' } } }) }, from: () => { const b = {}; for (const m of ['select', 'eq', 'order']) b[m] = () => b; b.limit = async () => ({ data: [{ stripe_customer_id: 'cus_1', status: 'active' }], error: null }); return b; } };
 const handler = portalHandler({ env: { APP_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk' }, createClient: () => client, fetcher });
 const req = new Request(origin + '/api/billing/portal', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
 const r = await handler(req); assert.equal(r.status, 200); assert.equal((await r.json()).url, 'https://billing.stripe.com/session/abc');
 assert.equal(calls[0].body.get('customer'), 'cus_1'); assert.equal(calls[0].body.get('return_url'), origin + '/account/');
 assert.equal((await handler(new Request(origin + '/api/billing/portal', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }))).status, 403);
 assert.equal((await portalHandler({ env: { APP_ORIGIN: origin }, createClient: () => client })(req)).status, 503);
});
test('the sender drains pending emails through SendGrid and records failures without retrying', async () => {
 const admin = fakeAdmin({ outbound_emails: [{ id: 'm1', to_email: 'a@example.com', subject: 'S', body: 'B', sent_at: null, failed_at: null }, { id: 'm2', to_email: 'bad@example.com', subject: 'S', body: 'B', sent_at: null, failed_at: null }] });
 const sent = [];
 const fetcher = async (url, init) => { const msg = JSON.parse(init.body); sent.push(msg.personalizations[0].to[0].email); return { ok: msg.personalizations[0].to[0].email !== 'bad@example.com', status: 400 }; };
 assert.match((await runSender({ env: { SUPABASE_SERVICE_ROLE_KEY: 's' }, makeClient: () => admin })).skipped, /SENDGRID/);
 const result = await runSender({ env: { SUPABASE_SERVICE_ROLE_KEY: 's', SENDGRID_API_KEY: 'k', EMAIL_FROM: 'hello@joinsafekeep.com' }, makeClient: () => admin, fetcher, now: () => NOW });
 assert.deepEqual(result, { pending: 2, sent: 1, failed: 1 }); assert.deepEqual(sent, ['a@example.com', 'bad@example.com']);
 assert.equal(admin.tables.outbound_emails[0].sent_at, NOW.toISOString()); assert.match(admin.tables.outbound_emails[1].failure, /SendGrid 400/);
});
