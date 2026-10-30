// The words of the monthly report, built from the numbers practice_metrics() returns. Shared by the email sender
// (Node) and the account page and family web view (browser), so all three say the same thing. No percentages and no
// grades, per the PRD; family see counts and categories, never the content of a practice.

const CATEGORY = {
 delivery: 'delivery and parcel messages', prize: 'prize and sweepstakes messages', tech_support: 'computer and tech support warnings',
 bank: 'messages that claim to be from your bank', utility: 'utility shut-off threats', government: 'messages that claim to be from a government office',
 family_emergency: '"it\'s me" family emergency messages', charity: 'charity appeals', medicare: 'Medicare messages', romance: 'friendly strangers who get in touch by mistake',
 election: 'election and voter messages', account_takeover: 'requests to sign in or reset a password', shopping: 'order and shopping alerts', health: 'messages about your health or test results'
};
const CHANNEL = { email: ['email', 'emails'], text: ['text', 'texts'], phone: ['call', 'calls'] };
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = n => (n >= 0 && n <= 10 ? WORDS[n] : String(n));
const Num = n => { const w = num(n); return w.charAt(0).toUpperCase() + w.slice(1); };
const list = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
export const categoryWords = c => CATEGORY[c] || `${String(c).replace(/_/g, ' ')} messages`;
export const monthName = iso => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function channels(m) {
 const parts = Object.entries(m.by_channel || {}).filter(([, n]) => n > 0).map(([c, n]) => `${num(n)} ${CHANNEL[c][n === 1 ? 0 : 1]}`);
 return parts.length > 1 ? `: ${list(parts)}` : '';
}

// For the participant: "you", with the practice opportunities named so they can reopen the coaching.
export function participantReport(m, { welcome = false } = {}) {
 const out = [];
 const opps = m.opportunities || [];
 if (!m.received) return { paragraphs: ['No practice messages reached you this time. If that seems wrong, check that practice is turned on in your account.'], opportunities: [] };
 out.push(`${welcome ? 'So far you’ve' : 'This month you'} received ${num(m.received)} practice ${m.received === 1 ? 'message' : 'messages'}${channels(m)}.`);
 if (m.spotted) out.push(`You spotted ${m.spotted === m.received ? (m.received === 1 ? 'it' : `all ${num(m.spotted)}`) : `${num(m.spotted)} of them`}.`);
 if (m.ignored) out.push(`You ignored ${num(m.ignored)}, which is a fine response too.`);
 if (opps.length) {
  out.push(`${Num(opps.length)} ${opps.length === 1 ? 'was a practice opportunity, so here it is again' : 'were practice opportunities, so here they are again'}, with what to look for next time.`);
  const coached = opps.filter(o => o.coached).length;
  if (coached === opps.length) out.push(opps.length === 1 ? 'You finished the coaching on it.' : 'You finished the coaching on all of them.');
  else if (coached) out.push(`You finished the coaching on ${num(coached)} of them.`);
 }
 if (m.streak_months >= 2) out.push(`That’s ${num(m.streak_months)} months in a row with nothing getting past you.`);
 else if (!welcome && m.last_month?.received) out.push(`Last month you spotted ${num(m.last_month.spotted)} of ${num(m.last_month.received)}.`);
 if ((m.weak_spots || []).length) out.push(`Lately, the ones to keep an eye out for are ${list(m.weak_spots.map(categoryWords))}.`);
 return { paragraphs: out, opportunities: opps };
}

// For family: the participant by name, counts and categories only.
export function familyReport(m, name, { welcome = false } = {}) {
 const out = [];
 const opps = m.opportunities || [];
 if (!m.received) return { paragraphs: [`${name} didn’t receive any practice messages ${welcome ? 'yet' : 'this month'}.`] };
 out.push(`${welcome ? `${name} has started practising with Safekeep and has` : `This month ${name}`} received ${num(m.received)} practice ${m.received === 1 ? 'message' : 'messages'}${channels(m)}.`);
 if (m.spotted) out.push(`${name} spotted ${m.spotted === m.received ? (m.received === 1 ? 'it' : `all ${num(m.spotted)}`) : `${num(m.spotted)} of them`}.`);
 if (m.ignored) out.push(`${name} ignored ${num(m.ignored)}, which is a fine response too.`);
 if (opps.length) {
  const kinds = list([...new Set(opps.map(o => categoryWords(o.category)))]);
  const coachedAll = opps.every(o => o.coached);
  out.push(`${Num(opps.length)} ${opps.length === 1 ? 'was a practice opportunity' : 'were practice opportunities'} (${kinds})${coachedAll ? `, and ${name} went through the coaching on ${opps.length === 1 ? 'it' : 'them'}` : ''}.`);
 }
 if (m.streak_months >= 2) out.push(`That’s ${num(m.streak_months)} months in a row with nothing getting past ${name}.`);
 if ((m.weak_spots || []).length) out.push(`It may be worth talking together about ${list(m.weak_spots.map(categoryWords))}.`);
 out.push(`A good way to help is to ask ${name} about one of these next time you talk, and to agree what you’d each do if a message like this ever came from “you”.`);
 return { paragraphs: out };
}
