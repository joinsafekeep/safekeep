import { createClient } from '@supabase/supabase-js';
import sourcesConfig from '../../content/alert-sources.json' with { type: 'json' };
import { collect } from './lib/alert-sources.mjs';
import { buildPrompt, parseDraft, callClaude, excerpt, weekOf } from './lib/alert-draft.mjs';
import { checkAlert, parseFrontMatter } from './lib/alert-check.mjs';
import { github } from './lib/github.mjs';
import { validateScenario } from './lib/practice-library.mjs';
import { authorized } from './lib/job-auth.mjs';

// The weekly alert job (a background function, so it may run for several minutes). Started on Monday morning by
// scheduled-alerts.mjs, or by "Draft this week's alert" on /admin/. Steps, per the PRD:
//  1. collect the week's items from content/alert-sources.json into source_items (each URL and text once);
//  2. draft with Claude from STYLE.md, KEYWORDS.md, the README's front-matter spec, the last four alerts and the
//     unused sources;
//  3. check (lib/alert-check.mjs); one redraft with the problems listed; whatever remains goes to a person;
//  4. open a pull request adding content/scam-alerts/weekly-<date>.md with draft: true, listing the check result,
//     so the Netlify deploy preview shows it and Ian approves by setting draft: false and merging;
//  5. put the practice scams drafted from the lead story into the admin review queue as drafts.
// Nothing here publishes or sends anything.
export async function runAlertDraft({ env = process.env, makeClient = createClient, fetcher = globalThis.fetch, now = () => new Date(), force = false } = {}) {
 const missing = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'].filter(k => !env[k]);
 if (missing.length) return { skipped: `Set ${missing.join(', ')} first` };
 const admin = makeClient(env.SUPABASE_URL || 'https://iybcbztvofqihvqhqfoo.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
 const must = r => { if (r.error) throw r.error; return r.data; };
 const date = weekOf(now()), slug = `weekly-${date}`;
 const existing = must(await admin.from('alerts').select('id,status,pr_url').eq('slug', slug).maybeSingle());
 if (existing && existing.status !== 'failed' && !force) return { skipped: `${slug} is already ${existing.status}`, pr_url: existing.pr_url };
 const alertId = existing?.id || must(await admin.from('alerts').insert({ slug, week_of: date, status: 'drafted' }).select('id').single()).id;
 const fail = async (report) => { await admin.from('alerts').update({ status: 'failed', check_report: report }).eq('id', alertId); return { failed: true, ...report }; };

 // 1. Collect.
 const collected = await collect({ config: sourcesConfig, fetcher, now: now() });
 for (const item of collected.items) {
  const r = await admin.from('source_items').insert(item);
  if (r.error && r.error.code !== '23505') collected.errors.push(`save ${item.url}: ${r.error.message}`);
 }
 const since = new Date(now().getTime() - (sourcesConfig.lookback_days || 8) * 86400000).toISOString();
 const pool = must(await admin.from('source_items').select('id,url,publisher,kind,title,text,published_at').is('used_in_alert_id', null).gte('fetched_at', since).order('published_at', { ascending: false }).limit(40)) || [];
 const sources = [...pool.filter(s => s.kind === 'primary'), ...pool.filter(s => s.kind !== 'primary')].slice(0, 25);
 if (!sources.length) return fail({ problems: ['No new source items this week.'], collection_errors: collected.errors });

 // 2. Context from the repository, as it is on main.
 const gh = github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO || 'joinsafekeep/safekeep', fetcher });
 const [style, keywords, readme, listing] = await Promise.all([gh.read('content/STYLE.md'), gh.read('content/KEYWORDS.md'), gh.read('README.txt'), gh.list('content/scam-alerts')]);
 const frontMatterSpec = ((readme || '').match(/SCAM ALERTS[\s\S]*$/) || [''])[0];
 const recentFiles = listing.filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(f.name)).map(f => f.name).sort().slice(-4);
 const recent = await Promise.all(recentFiles.map(async name => ({ slug: name.replace(/\.md$/, ''), excerpt: excerpt((await gh.read(`content/scam-alerts/${name}`)) || '') })));

 // 3. Draft and check, with one redraft.
 const model = env.ALERT_MODEL || 'claude-opus-5-5';
 let draft = null, problems = null, attempts = 0;
 for (; attempts < 2; ) {
  attempts += 1;
  const prompt = buildPrompt({ style: style || '', keywords: keywords || '', frontMatterSpec, recent, sources, date, problems, previous: draft?.markdown });
  let text;
  try { text = await callClaude({ apiKey: env.ANTHROPIC_API_KEY, model, system: prompt.system, user: prompt.user, fetcher }); }
  catch (e) { if (!draft) return fail({ problems: [`Drafting failed: ${e.message}`], collection_errors: collected.errors }); break; }
  const next = parseDraft(text);
  if (!next.markdown.trim().startsWith('---')) { if (!draft) draft = next; problems = ['The draft came back without front matter.']; continue; }
  draft = { markdown: next.markdown, practice: next.practice.length ? next.practice : draft?.practice || [] };
  problems = checkAlert(draft.markdown, sources, { today: now() });
  if (!problems.length) break;
 }
 if (!draft?.markdown?.trim().startsWith('---')) return fail({ problems: problems || ['No draft came back.'], collection_errors: collected.errors });

 // 5 (before the PR, so the PR can say what went to the queue). Practice candidates become drafts.
 const queued = [], skipped = [];
 for (const candidate of draft.practice) {
  const format = ['email', 'text', 'phone'].includes(candidate?.format) ? candidate.format : null;
  const sc = candidate?.channel_variant?.script;
  const c = format === 'phone' && sc ? { ...candidate, content: [sc.opening, sc.hook, sc.pressure].join('\n\n') } : candidate;
  const issues = format ? validateScenario(c, format) : ['unknown format'];
  if (issues.length) { skipped.push(`${c?.name || c?.code || 'unnamed'} (${format || '?'}): ${issues.join('; ')}`); continue; }
  const code = `${c.code}-${date.replace(/-/g, '')}`.slice(0, 60);
  const scam = must(await admin.from('practice_scams').upsert({ stable_code: code, name: c.name, category: c.category }, { onConflict: 'stable_code' }).select('id').single());
  const variant = format === 'email' ? { from_name: c.from_name, from_local: c.from_local } : (c.channel_variant || {});
  const r = await admin.from('practice_scam_versions').insert({ scam_id: scam.id, version_number: 1, format, difficulty: c.difficulty, subject: c.subject || null, content: c.content, learning_objective: c.learning_objective, warning_signs: (c.tells || []).map(t => t.note), debrief: c.debrief, status: 'draft', tells: c.tells, channel_variant: variant, brand_mode: 'generic', generated_by: 'model', next_steps: c.next_steps, question: c.question, source_alert_id: alertId, context_url: `/scam-alerts/${slug}` });
  if (r.error) skipped.push(`${c.name}: ${r.error.message}`); else queued.push(`${c.name} (${format}, difficulty ${c.difficulty})`);
 }

 // 4. The pull request.
 const { meta } = parseFrontMatter(draft.markdown);
 const cited = sources.filter(s => draft.markdown.includes(s.url));
 const body = [
  `This week's Scam Alert, drafted from ${sources.length} fetched items. **It isn't published until you set \`draft: false\` and merge.**`,
  '',
  problems?.length ? `### The automated check still has concerns\nThese survived one redraft, so please look at each one:\n${problems.map(p => `- ${p}`).join('\n')}` : '### The automated check passed\nEvery cited link was fetched this week, every number appears in a source, and the title and description are the right length.',
  '',
  '### To review',
  '1. Read it on the deploy preview (the Netlify check below links to it; drafts show there with a banner).',
  '2. Spot-check the lead story against its source.',
  '3. Edit in GitHub if anything reads wrong, then change `draft: true` to `draft: false` in the front matter and merge. Members get the email after the deploy finishes.',
  '',
  `### Sources it used (${cited.length})`, ...cited.map(s => `- [${s.title}](${s.url}) (${s.publisher})`),
  '', `### Practice scams sent to the review queue (${queued.length})`, ...(queued.length ? queued.map(q => `- ${q}`) : ['- None this week']),
  ...(skipped.length ? ['', '### Practice ideas that failed the library check', ...skipped.map(s => `- ${s}`)] : []),
  ...(collected.errors.length ? ['', '<details><summary>Feeds or pages that could not be fetched</summary>', '', ...collected.errors.map(e => `- ${e}`), '</details>'] : []),
  '', `_Drafted by ${model} in ${attempts} attempt${attempts === 1 ? '' : 's'}._`
 ].join('\n');
 let prUrl;
 try {
  prUrl = await gh.openPullRequest({ branch: `alert/${slug}`, path: `content/scam-alerts/${slug}.md`, content: draft.markdown, message: `Draft Scam Alert for the week of ${date}`, title: `Scam Alert draft: ${meta?.title || slug}`, body });
 } catch (e) { return fail({ problems: [`Could not open the pull request: ${e.message}`], draft_problems: problems || [] }); }
 must(await admin.from('alerts').update({ status: 'in_review', pr_url: prUrl, title: meta?.title || null, check_report: { problems: problems || [], attempts, sources: sources.length, cited: cited.length, practice_queued: queued.length, practice_skipped: skipped, collection_errors: collected.errors } }).eq('id', alertId));
 if (cited.length) must(await admin.from('source_items').update({ used_in_alert_id: alertId }).in('id', cited.map(s => s.id)));
 return { slug, pr_url: prUrl, problems: problems || [], attempts, practice_queued: queued.length };
}

export { authorized };

export default async request => {
 if (request.method !== 'POST' || !authorized(request, process.env.ALERTS_JOB_SECRET)) return new Response('Not found', { status: 404 });
 const force = new URL(request.url).searchParams.get('force') === '1';
 try { console.log('alerts-draft', JSON.stringify(await runAlertDraft({ force }))); }
 catch (e) { console.log('alerts-draft failed', String(e?.message || e)); }
 return new Response(null, { status: 202 });
};
