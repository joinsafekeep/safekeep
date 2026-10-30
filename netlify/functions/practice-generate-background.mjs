import { createClient } from '@supabase/supabase-js';
import { callClaude, parseDraft } from './lib/alert-draft.mjs';
import { github } from './lib/github.mjs';
import { validateScenario } from './lib/practice-library.mjs';
import { authorized } from './lib/job-auth.mjs';

// Weekly practice scam drafts (PRD: Practice scam engine > Library, "Generation runs weekly from three inputs"):
//  - the latest Scam Alert,
//  - source items from the last two weeks that didn't make the alert,
//  - the backlog: categories thin in a channel, or where participants now spot almost everything.
// Claude drafts up to six scenarios in the library's format; each one that passes the same check as the seed
// (no real brands, warning signs quoted word for word, call scripts that offer "press 1", no "fail" or "victim") goes
// into the /admin/ review queue as a draft. Nothing is published or sent from here.
// Started on Wednesday morning by scheduled-generate.mjs, or from /admin/.
export function buildGeneratePrompt({ style, alert, leftovers, gaps, date }) {
 const system = `You write practice scams for Safekeep, a service that sends realistic but harmless practice scams to older adults who signed up for them, and then shows them the warning signs. Every practice impersonates a role ("your bank", "the county court", "a parcel company"), never a real company, agency or person by name; asks for nothing real; and never mentions family members by name. The coaching text follows the house style guide exactly.

<style_guide>
${style}
</style_guide>`;
 const user = `Today is ${date}. Draft six new practice scams: two emails, two texts and two calls.

Choose them from these inputs, and say nothing about the inputs in the drafts themselves:
1. The latest Scam Alert, which is what's going around now:
<alert>
${alert || '(none this week)'}
</alert>
2. Other items from the last two weeks that the alert didn't cover:
<leftovers>
${leftovers.map(s => `<item publisher="${s.publisher}" url="${s.url}"><title>${s.title}</title>\n${String(s.text).slice(0, 3000)}</item>`).join('\n') || '(none)'}
</leftovers>
3. The library as it stands. Favour categories with few published versions in a channel, and categories where people's practice-opportunity rate is low (they now spot those easily, so harder versions would teach more). Don't repeat an existing scenario.
<library>
${JSON.stringify(gaps)}
</library>

Mix difficulty from 1 to 5, leaning toward 2 to 4. Return only this:
<practice>
(a JSON array of six items; each item: {"format":"email"|"text"|"phone","code":"lowercase-words-with-hyphens, new","name":"short name","category":"an existing category if one fits","difficulty":1-5,"from_name":"(email) role-based sender name","from_local":"(email) like account-notices","subject":"(email)","content":"email body with {link} where the link goes; text under 230 characters with {link} or a reply prompt; empty for phone","channel_variant":{"reply_keywords":["(text) the replies it invites, never STOP, CANCEL, END, QUIT, HELP, START or REPORT"],"script":{"opening":"(phone) two or three spoken sentences","hook":"(phone) must offer 'press 1 or say yes'","pressure":"(phone) one line of pressure"}},"tells":[{"quote":"exact words from the content or script","note":"one kind sentence on why it's a warning sign"}],"next_steps":["two or three things the person would say they'll do next time"],"learning_objective":"one sentence","debrief":"two or three sentences in the house style","question":{"prompt":"If this had been real, what would have been the first sign it wasn't?","choices":["three short choices"],"correct":0,"affirm":"one sentence","gently":"one sentence"}})
</practice>`;
 return { system, user };
}

export async function runGenerate({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, now = () => new Date() } = {}) {
 const missing = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'].filter(k => !env[k]);
 if (missing.length) return { skipped: `Set ${missing.join(', ')} first` };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const date = now().toISOString().slice(0, 10);
 const gh = github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO || 'joinsafekeep/safekeep', fetcher });
 const [style, listing] = await Promise.all([gh.read('content/STYLE.md'), gh.list('content/scam-alerts')]);
 const latest = listing.filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(f.name)).map(f => f.name).sort().at(-1);
 const alert = latest ? (await gh.read(`content/scam-alerts/${latest}`) || '').slice(0, 14000) : '';
 const since = new Date(now().getTime() - 14 * 86400000).toISOString();
 const leftovers = must(await admin.from('source_items').select('url,publisher,title,text').is('used_in_alert_id', null).gte('fetched_at', since).order('published_at', { ascending: false }).limit(10)) || [];
 const gaps = must(await admin.rpc('library_gaps'));
 const prompt = buildGeneratePrompt({ style: style || '', alert, leftovers, gaps, date });
 const text = await callClaude({ apiKey: env.ANTHROPIC_API_KEY, model: env.PRACTICE_MODEL || env.ALERT_MODEL || 'claude-opus-5-5', system: prompt.system, user: prompt.user, fetcher });
 const { practice } = parseDraft(`<alert></alert>${text}`);
 const taken = new Set(gaps?.codes || []);
 const queued = [], skipped = [];
 for (const candidate of practice.slice(0, 8)) {
  const format = ['email', 'text', 'phone'].includes(candidate?.format) ? candidate.format : null;
  const sc = candidate?.channel_variant?.script;
  const c = format === 'phone' && sc ? { ...candidate, content: [sc.opening, sc.hook, sc.pressure].join('\n\n') } : candidate;
  const issues = format ? validateScenario(c, format) : ['unknown format'];
  let code = String(c?.code || '');
  if (taken.has(code)) code = `${code}-${date.replace(/-/g, '')}`.slice(0, 60);
  if (taken.has(code)) issues.push('repeats an existing scenario');
  if (issues.length) { skipped.push({ name: c?.name || c?.code || 'unnamed', format, issues }); continue; }
  taken.add(code);
  // One bad draft (a code that clashes with an archived scam, say) is skipped without stopping the rest, and never
  // leaves a scam behind with no version.
  const scam = await admin.from('practice_scams').insert({ stable_code: code, name: c.name, category: c.category }).select('id').single();
  if (scam.error) { skipped.push({ name: c.name, format, issues: [scam.error.message] }); continue; }
  const variant = format === 'email' ? { from_name: c.from_name, from_local: c.from_local } : (c.channel_variant || {});
  const version = await admin.from('practice_scam_versions').insert({ scam_id: scam.data.id, version_number: 1, format, difficulty: c.difficulty, subject: c.subject || null, content: c.content, learning_objective: c.learning_objective, warning_signs: (c.tells || []).map(t => t.note), debrief: c.debrief, status: 'draft', tells: c.tells, channel_variant: variant, brand_mode: 'generic', generated_by: 'model', next_steps: c.next_steps, question: c.question });
  if (version.error) { await admin.from('practice_scams').delete().eq('id', scam.data.id); skipped.push({ name: c.name, format, issues: [version.error.message] }); continue; }
  queued.push(`${c.name} (${format}, difficulty ${c.difficulty})`);
 }
 return { queued, skipped };
}

export default async request => {
 if (request.method !== 'POST' || !authorized(request, process.env.ALERTS_JOB_SECRET)) return new Response('Not found', { status: 404 });
 try { console.log('practice-generate', JSON.stringify(await runGenerate())); }
 catch (e) { console.log('practice-generate failed', String(e?.message || e)); }
 return new Response(null, { status: 202 });
};
