import { sessionClient, validateRequest, jsonHeaders } from './lib/session.mjs';

// POST /api/billing/portal: a Stripe Billing Portal session for the signed-in sponsor's customer, so Stripe knows
// which customer is cancelling or changing a card. The bare portal login link in the site footer stays for people
// who paid through a Payment Link before accounts existed.
export function makeHandler({ createClient, env = process.env, fetcher = globalThis.fetch } = {}) {
 return async request => {
  const headers = jsonHeaders();
  const reply = (body, status=200) => new Response(JSON.stringify(body), {status,headers});
  const origin = env.APP_ORIGIN || env.DEPLOY_PRIME_URL || env.URL;
  if (!origin) return reply({error:'Account setup is not complete yet.'},503);
  try { validateRequest(request, new URL(origin).origin); } catch { return reply({error:'Request blocked.'},403); }
  if (request.method !== 'POST') return reply({error:'Method not allowed.'},405);
  if (!env.STRIPE_SECRET_KEY) return reply({error:'Subscription management isn’t connected yet. Use Manage subscription at the bottom of any Safekeep page.'},503);
  const client = sessionClient({request, headers, env, createClient});
  try {
   const {data:{user},error} = await client.auth.getUser();
   if (error || !user || !user.email_confirmed_at || user.is_anonymous) return reply({signed_in:false},401);
   const {data:subs, error:subError} = await client.from('subscriptions').select('stripe_customer_id,status,created_at').eq('sponsor_user_id',user.id).order('created_at',{ascending:false}).limit(1);
   if (subError) throw subError;
   if (!subs?.length) return reply({error:'There is no plan on this account yet. If you paid before creating an account, use Manage subscription at the bottom of any Safekeep page and enter the email you paid with.'},404);
   const body = new URLSearchParams({ customer: subs[0].stripe_customer_id, return_url: `${new URL(origin).origin}/account/` });
   const response = await fetcher('https://api.stripe.com/v1/billing_portal/sessions', { method:'POST', headers:{ Authorization:`Bearer ${env.STRIPE_SECRET_KEY}` }, body });
   const session = await response.json().catch(()=>({}));
   if (!response.ok || !session.url) return reply({error:'Stripe could not open your subscription right now. Please try again in a few minutes.'},502);
   return reply({url:session.url});
  } catch {
   // Never log the request body, tokens or personal data.
   return reply({error:'Unable to complete this request. Please try again.'},400);
  }
 };
}
export default makeHandler();
export const config = { path: '/api/billing/portal' };
