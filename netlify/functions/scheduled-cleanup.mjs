import { createClient } from '@supabase/supabase-js';

// Daily cleanup. This is the one place a service-role key is used in a request-free context, as the PRD allows for
// scheduled jobs. It hard-deletes two kinds of auth user, and the database cascades the rest:
//  - accounts whose self-service deletion request is 30 days old and was not cancelled (account_deletions);
//  - sign-ups that never verified their email within 30 days, so a half-finished sign-up does not sit on file.
// Nothing is logged beyond counts.
export const DELETE_AFTER_DAYS = 30;

export async function runCleanup({ env = process.env, now = () => new Date(), makeClient = createClient } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const cutoff = new Date(now().getTime() - DELETE_AFTER_DAYS * 86400000).toISOString();
 const must = r => { if (r.error) throw r.error; return r.data; };
 const toDelete = new Set();
 // 1. Requested deletions past the grace period.
 for (const row of must(await admin.from('account_deletions').select('user_id,requested_at').is('cancelled_at', null).lte('requested_at', cutoff))) toDelete.add(row.user_id);
 const requested = toDelete.size;
 // 2. Unconfirmed sign-ups older than the grace period (paged; the list API tops out at 1000 per page).
 let page = 1;
 for (;;) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) if (!u.email_confirmed_at && !u.is_anonymous && u.created_at < cutoff) toDelete.add(u.id);
  if (data.users.length < 1000) break;
  page += 1;
 }
 let deleted = 0, failed = 0;
 for (const id of toDelete) {
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) failed += 1; else deleted += 1;
 }
 return { requested, unconfirmed: toDelete.size - requested, deleted, failed, cutoff };
}

export default async () => {
 const result = await runCleanup();
 console.log('cleanup', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '@daily' };
