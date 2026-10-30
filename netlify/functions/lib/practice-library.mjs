// The checks every practice scam passes before it can enter the review queue, whether hand-written in
// content/practice-library or drafted from a Scam Alert. Shared by scripts/build-practice-seed.mjs and the alert job.
export const FORMATS = ['email', 'text', 'phone'];
// Real brands and agencies a practice must not name (PRD: impersonate roles, not companies). Not exhaustive; review
// still happens by hand.
const BRANDS = /\b(amazon|usps|ups|fedex|dhl|irs|social security administration|ssa\.gov|medicare\.gov|cms|chase|wells fargo|bank of america|citi|paypal|venmo|zelle|apple|microsoft|google|netflix|walmart|costco|norton|mcafee|geek squad|comcast|xfinity|verizon|at&t|facebook|meta)\b/i;
const BANNED_WORDS = /\b(fail(ed|ure)?|fell for|victim)\b/i;

export function validateScenario(s, format) {
 const problems = [];
 const need = ['code', 'name', 'category', 'difficulty', 'content', 'learning_objective', 'debrief'];
 for (const k of need) if (s[k] === undefined || s[k] === '') problems.push(`missing ${k}`);
 if (!/^[a-z0-9-]{3,60}$/.test(s.code || '')) problems.push('code must be lowercase words joined by hyphens');
 if (!(s.difficulty >= 1 && s.difficulty <= 5)) problems.push('difficulty must be 1 to 5');
 if (format === 'email') {
  if (!s.subject) problems.push('email needs a subject');
  if (!s.from_name || !/^[a-z0-9.-]{2,40}$/.test(s.from_local || '')) problems.push('email needs from_name and a from_local like "delivery-notice"');
  if (!(s.content || '').includes('{link}')) problems.push('email content needs {link}');
 }
 const tells = s.tells || [];
 if (tells.length < 2 || tells.length > 4) problems.push('two to four tells');
 for (const t of tells) if (!t.quote || !t.note || !(s.content || '').includes(t.quote)) problems.push(`tell not found word for word in content: ${t.quote}`);
 if (!Array.isArray(s.next_steps) || s.next_steps.length < 2 || s.next_steps.length > 3) problems.push('two or three next steps');
 const q = s.question;
 if (!q || !q.prompt || !Array.isArray(q.choices) || q.choices.length !== 3 || !(q.correct >= 0 && q.correct <= 2) || !q.affirm || !q.gently) problems.push('question needs a prompt, three choices, a correct index, affirm and gently');
 const visible = [s.from_name, s.subject, s.content].join(' ');
 if (BRANDS.test(visible)) problems.push(`names a real brand or agency: ${visible.match(BRANDS)[0]}`);
 const coaching = [s.debrief, ...(s.next_steps || []), ...tells.map(t => t.note), q?.affirm, q?.gently].join(' ');
 if (BANNED_WORDS.test(coaching)) problems.push(`coaching uses a word we don't use: ${coaching.match(BANNED_WORDS)[0]}`);
 if (s.expires_at && Number.isNaN(Date.parse(s.expires_at))) problems.push('expires_at must be a date');
 if (s.context_url && !/^\/[a-z0-9/-]+$/.test(s.context_url)) problems.push('context_url must be a site path');
 return problems;
}

