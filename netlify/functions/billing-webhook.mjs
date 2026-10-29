import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

// POST /api/billing/webhook: Stripe is the source of truth for subscriptions. Every event is verified against the
// signing secret, recorded once in webhook_events (idempotent on the Stripe event id), then applied with the service
// role, which the PRD allows for webhooks. Handles:
//  - checkout.session.completed            → the subscription row and the sponsor's seat (client_reference_id = user id)
//  - customer.subscription.created/updated  → status, price, period end, cancel_at; past-due bookkeeping
//  - customer.subscription.deleted          → end_subscription: seats inactive, queue cancelled, two plain emails
//  - invoice.payment_failed / invoice.paid  → dunning: one email on the first failure, cleared when paid
//  - charge.refunded                        → refunded_at, so reports and metrics leave the account out
// A Payment Link checkout fires the same events, so this works before /api/billing/checkout exists.
export const STATUSES = ['incomplete','incomplete_expired','trialing','active','past_due','unpaid','paused','canceled'];
const ENDED = ['canceled','unpaid','incomplete_expired'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ts = seconds => typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
const idOf = value => typeof value === 'string' ? value : value?.id || null;

export function verifyStripeSignature(header, payload, secret, now = Date.now, tolerance = 300) {
 if (!header || !secret) return false;
 const parts = Object.create(null); const v1 = [];
 for (const item of header.split(',')) { const [k, v] = item.split('=', 2); if (k === 'v1') v1.push(v); else parts[k] = v; }
 const t = Number(parts.t);
 if (!v1.length || !Number.isFinite(t) || Math.abs(now() / 1000 - t) > tolerance) return false;
 const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
 return v1.some(sig => sig.length === expected.length && timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8')));
}

// The columns a Stripe subscription object maps onto. Newer Stripe API versions keep the period end on the item.
export function subscriptionFields(sub, nowIso) {
 const item = sub.items?.data?.[0];
 return {
  stripe_customer_id: idOf(sub.customer), stripe_subscription_id: sub.id, price_id: item?.price?.id || null,
  status: STATUSES.includes(sub.status) ? sub.status : 'incomplete',
  current_period_end: ts(sub.current_period_end ?? item?.current_period_end), cancel_at: ts(sub.cancel_at), canceled_at: ts(sub.canceled_at), ended_at: ts(sub.ended_at),
  updated_at: nowIso
 };
}

export async function handleEvent(event, { admin, env, fetcher = globalThis.fetch, now = () => new Date() }) {
 const must = r => { if (r.error) throw r.error; return r.data; };
 const nowIso = now().toISOString();
 const obj = event.data?.object || {};
 const stripeGet = async path => { const r = await fetcher(`https://api.stripe.com${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }); if (!r.ok) throw new Error(`Stripe ${r.status} on ${path}`); return r.json(); };
 const planFor = async priceId => priceId ? must(await admin.from('price_plans').select('plan,billing,seats').eq('price_id', priceId).maybeSingle()) : null;
 const findBySubscription = async id => must(await admin.from('subscriptions').select('*').eq('stripe_subscription_id', id).maybeSingle());
 const sponsorEmail = async userId => { const { data } = await admin.auth.admin.getUserById(userId); return data?.user?.email || null; };
 // Writes the subscription's current state. Creates the row only when the sponsor is known.
 const apply = async (sub, sponsorUserId) => {
  const fields = subscriptionFields(sub, nowIso);
  const plan = await planFor(fields.price_id);
  if (plan) Object.assign(fields, { plan: plan.plan, billing: plan.billing, seats: plan.seats });
  let row = await findBySubscription(sub.id);
  if (!row && !sponsorUserId) {
   // A subscription we have not seen through checkout: reuse the sponsor of an earlier plan on the same customer.
   const earlier = must(await admin.from('subscriptions').select('sponsor_user_id').eq('stripe_customer_id', fields.stripe_customer_id).order('created_at', { ascending: false }).limit(1));
   sponsorUserId = earlier?.[0]?.sponsor_user_id || null;
  }
  if (!row && !sponsorUserId) return { skipped: 'no account for this subscription' };
  fields.past_due_since = fields.status === 'past_due' ? (row?.past_due_since || nowIso) : null;
  const alreadyEnded = !!row?.ended_at; // decided before the write below copies Stripe's ended_at onto the row
  if (row) {
   row = must(await admin.from('subscriptions').update(fields).eq('id', row.id).select().single());
  } else {
   row = must(await admin.from('subscriptions').insert({ ...fields, sponsor_user_id: sponsorUserId }).select().single());
   must(await admin.from('subscription_members').upsert({ subscription_id: row.id, user_id: sponsorUserId, role: 'sponsor', status: 'active' }, { onConflict: 'subscription_id,user_id', ignoreDuplicates: true }));
  }
  if (ENDED.includes(fields.status) && !alreadyEnded) {
   must(await admin.rpc('end_subscription', { sid: row.id, ended: fields.ended_at || fields.canceled_at || nowIso }));
   return { subscription: row.id, status: fields.status, ended: true };
  }
  return { subscription: row.id, status: fields.status };
 };

 switch (event.type) {
  case 'checkout.session.completed': {
   if (obj.mode !== 'subscription' || !obj.subscription) return { skipped: 'not a subscription checkout' };
   const ref = obj.client_reference_id;
   if (!ref || !UUID.test(ref)) return { skipped: 'no account reference (pre-account Payment Link)' };
   const { data } = await admin.auth.admin.getUserById(ref);
   if (!data?.user) return { skipped: 'client_reference_id is not an account' };
   return apply(await stripeGet(`/v1/subscriptions/${idOf(obj.subscription)}`), ref);
  }
  case 'customer.subscription.created':
  case 'customer.subscription.updated':
   return apply(obj, null);
  case 'customer.subscription.deleted':
   return apply({ ...obj, status: 'canceled', ended_at: obj.ended_at || Math.floor(now().getTime() / 1000) }, null);
  case 'invoice.payment_failed': {
   const row = await findBySubscription(idOf(obj.subscription) || idOf(obj.parent?.subscription_details?.subscription));
   if (!row) return { skipped: 'unknown subscription' };
   must(await admin.from('subscriptions').update({ status: 'past_due', past_due_since: row.past_due_since || nowIso, updated_at: nowIso }).eq('id', row.id));
   if ((obj.attempt_count || 1) > 1) return { subscription: row.id, dunning: 'retry, no email' };
   const to = await sponsorEmail(row.sponsor_user_id);
   if (to) must(await admin.from('outbound_emails').insert({ to_email: to, kind: 'payment_failed', subject: 'A Safekeep payment didn’t go through',
    body: `Hello,\n\nThe latest payment for your Safekeep plan didn’t go through. Stripe will try again over the next few days, and nothing changes for now. If it keeps failing, practice pauses after seven days and starts again as soon as a payment succeeds.\n\nTo update your card, sign in at https://joinsafekeep.com/account/ and choose Manage subscription. If you think this is a mistake, reply to this email and a person will help.\n\nThe Safekeep team` }));
   return { subscription: row.id, dunning: to ? 'emailed' : 'no email address' };
  }
  case 'invoice.paid': {
   const row = await findBySubscription(idOf(obj.subscription) || idOf(obj.parent?.subscription_details?.subscription));
   if (!row) return { skipped: 'unknown subscription' };
   if (row.status === 'past_due') must(await admin.from('subscriptions').update({ status: 'active', past_due_since: null, updated_at: nowIso }).eq('id', row.id));
   return { subscription: row.id, paid: true };
  }
  case 'charge.refunded': {
   const rows = must(await admin.from('subscriptions').select('id,refunded_at').eq('stripe_customer_id', idOf(obj.customer)).order('created_at', { ascending: false }).limit(1));
   if (!rows?.length) return { skipped: 'unknown customer' };
   if (!rows[0].refunded_at) must(await admin.from('subscriptions').update({ refunded_at: nowIso, updated_at: nowIso }).eq('id', rows[0].id));
   return { subscription: rows[0].id, refunded: true };
  }
  default:
   return { skipped: `unhandled ${event.type}` };
 }
}

export function makeHandler({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, now = () => new Date() } = {}) {
 return async request => {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_WEBHOOK_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY || !env.STRIPE_SECRET_KEY) return reply({ error: 'Billing webhook is not configured' }, 503);
  const payload = await request.text();
  if (!verifyStripeSignature(request.headers.get('stripe-signature'), payload, env.STRIPE_WEBHOOK_SECRET, () => now().getTime())) return reply({ error: 'Bad signature' }, 400);
  let event; try { event = JSON.parse(payload); } catch { return reply({ error: 'Invalid payload' }, 400); }
  if (!event?.id || !event?.type) return reply({ error: 'Invalid event' }, 400);
  const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  // Record first; a repeat delivery of a processed event is acknowledged without being applied again.
  const summary = { id: event.id, type: event.type, created: event.created, object: { id: event.data?.object?.id, customer: idOf(event.data?.object?.customer), subscription: idOf(event.data?.object?.subscription), status: event.data?.object?.status } };
  const { error: insertError } = await admin.from('webhook_events').insert({ provider: 'stripe', provider_event_id: event.id, event_type: event.type, payload: summary });
  if (insertError) {
   if (insertError.code !== '23505') return reply({ error: 'Could not record event' }, 500);
   const { data: seen } = await admin.from('webhook_events').select('processed_at').eq('provider', 'stripe').eq('provider_event_id', event.id).maybeSingle();
   if (seen?.processed_at) return reply({ received: true, duplicate: true });
  }
  try {
   const result = await handleEvent(event, { admin, env, fetcher, now });
   await admin.from('webhook_events').update({ processed_at: now().toISOString() }).eq('provider', 'stripe').eq('provider_event_id', event.id);
   return reply({ received: true, ...result });
  } catch (error) {
   // 500 makes Stripe retry; the event row stays unprocessed so the retry is applied. Nothing personal is logged.
   console.error('billing-webhook', event.type, String(error?.message || error));
   return reply({ error: 'Processing failed' }, 500);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/billing/webhook' };
