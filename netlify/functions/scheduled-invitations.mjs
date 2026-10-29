import { createClient } from '@supabase/supabase-js';

// Daily: the reminders and the expiry the PRD's risk table calls for, so a sponsor is never left wondering.
//  - day 3 and day 10: a short reminder to the invited person (once each), and nothing after an answer;
//  - day 14: the invitation lapses, the seat frees, and the sponsor gets one email saying so.
// Reminders re-use the invitation's link, which the database never stores in readable form, so they point the person
// at the original email instead of carrying a new link. A sponsor's "Resend" is the way to issue a fresh link.
const DAY = 86400000;
export async function runInvitationJob({ env = process.env, now = () => new Date(), makeClient = createClient } = {}) {
 if (!env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY is not set' };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const t = now().getTime(), iso = new Date(t).toISOString();
 const open = must(await admin.from('participant_invitations').select('id,subscription_id,inviter_user_id,invitee_email,invitee_name,created_at,expires_at,reminded_day3_at,reminded_day10_at,expired_notified_at').is('accepted_at', null).is('declined_at', null).is('revoked_at', null));
 const sponsorName = async id => { const p = must(await admin.from('user_profiles').select('first_name,preferred_name').eq('user_id', id).maybeSingle()); return p?.preferred_name || p?.first_name || 'Someone in your family'; };
 const sponsorEmail = async id => (await admin.auth.admin.getUserById(id)).data?.user?.email || null;
 let reminders = 0, expired = 0;
 for (const inv of open || []) {
  const age = t - new Date(inv.created_at).getTime();
  if (new Date(inv.expires_at).getTime() <= t) {
   if (inv.expired_notified_at) continue;
   must(await admin.from('participant_invitations').update({ expired_notified_at: iso, updated_at: iso }).eq('id', inv.id));
   const to = await sponsorEmail(inv.inviter_user_id);
   if (to) must(await admin.from('outbound_emails').insert({ to_email: to, kind: 'invitation_expired', subject: `${inv.invitee_name}’s Safekeep invitation has lapsed`,
    body: `Hello,\n\nThe invitation you sent ${inv.invitee_name} two weeks ago wasn’t answered, so it has lapsed and their seat on your plan is free again. Nothing was sent to them apart from the invitation and two reminders.\n\nIf you’d like to try again, perhaps after talking it over together, choose Resend next to their name on your account page: https://joinsafekeep.com/account/\n\nThe Safekeep team` }));
   expired += 1; continue;
  }
  const which = age >= 10 * DAY && !inv.reminded_day10_at ? 'reminded_day10_at' : age >= 3 * DAY && !inv.reminded_day3_at ? 'reminded_day3_at' : null;
  if (!which) continue;
  const sponsor = await sponsorName(inv.inviter_user_id);
  must(await admin.from('participant_invitations').update({ [which]: iso, updated_at: iso }).eq('id', inv.id));
  must(await admin.from('outbound_emails').insert({ to_email: inv.invitee_email, kind: 'invitation_reminder', subject: `A reminder: ${sponsor} has given you Safekeep`,
   body: `Hello ${inv.invitee_name},\n\nJust a gentle reminder that ${sponsor} has given you a Safekeep plan. The link to accept, or to say no thanks, is in the email we sent on ${new Date(inv.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })} with the subject “${sponsor} has given you Safekeep”.\n\nNothing is sent to you unless you say yes. If you can’t find that email, ${sponsor} can send a fresh one.\n\nThe Safekeep team` }));
  reminders += 1;
 }
 return { open: (open || []).length, reminders, expired };
}
export default async () => {
 const result = await runInvitationJob();
 console.log('invitations', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '@daily' };
