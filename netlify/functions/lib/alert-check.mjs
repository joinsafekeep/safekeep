// The automated pass every drafted Scam Alert goes through before it becomes a pull request (PRD: Scam Alerts
// content engine > Check). It rejects a draft when:
//  - a cited URL wasn't in the fetched set (a few standard "report it here" sites are allowed at their front page);
//  - a number in the body doesn't appear in any fetched source;
//  - seo_title is over 60 characters or description is outside 150-155;
//  - a phrase from STYLE.md's avoid-list appears;
//  - the front matter or the sections the format needs are missing.
// It returns a list of problems in plain words; an empty list passes.

// Front pages people are always pointed to for reporting or checking. Deeper links must come from fetched sources.
export const REFERENCE_SITES = ['reportfraud.ftc.gov', 'www.ic3.gov', 'ic3.gov', 'vote.gov', 'www.vote.gov', 'www.fec.gov', 'www.medicare.gov', 'www.identitytheft.gov', 'identitytheft.gov', 'www.ssa.gov', 'oig.ssa.gov', 'www.donotcall.gov', 'www.consumerfinance.gov', 'www.aarp.org', 'www.shiphelp.org', 'www.usa.gov'];
// Numbers that may appear without a source because they're fixed contact details, not facts about the story.
export const REFERENCE_NUMBERS = ['1-833-372-8311', '1-800-633-4227', '1-800-MEDICARE', '877-438-4338', '1-877-438-4338', '911', '988'];

// From STYLE.md, "Patterns to avoid". Phrases are matched case-insensitively as whole words.
export const AVOID_PHRASES = ["in today's world", "it's important to note", 'navigate', 'navigating', 'landscape', 'game-changer', 'game changer', 'empower', 'empowering', 'crucial', 'delve', 'the key is', "here's the thing", 'the one thing', 'the real problem', 'what most people miss', 'the takeaway:', 'the bright line', 'works every time', 'never fails', 'the only defense', 'the secret is'];
const CONTRAST_FLIP = /\b(it|this|that)[’']?s not (just )?(about )?[^.;:]{1,60}[,;.]\s*(it|this|that)[’']?s\b/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseFrontMatter(markdown) {
 const m = String(markdown).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
 if (!m) return { meta: null, body: String(markdown) };
 const meta = {};
 for (const line of m[1].split('\n')) { const kv = line.match(/^([a-z_]+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1'); }
 return { meta, body: m[2] };
}

const normalizeUrl = u => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase() + x.search; } catch { return u; } };
const squash = s => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ');
const digitsOnly = s => s.replace(/[,$%]/g, '');

// Numbers as written in prose: $1,500, 40%, 2.7 billion's 2.7, 1-833-372-8311. Dates are checked as dates.
function numbersIn(text) {
 const found = [];
 const withoutLinks = text.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
 const dateRe = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`, 'gi');
 const dates = [];
 const rest = withoutLinks.replace(dateRe, (all, month, day, year) => { dates.push({ month: month.toLowerCase(), day: Number(day), year: year || null, raw: all }); return ' '; });
 for (const m of rest.matchAll(/(?:\$\s?)?\b\d[\d,]*(?:\.\d+)?\b%?(?:-\d[\d-]*)?/g)) found.push(m[0].trim());
 return { numbers: found, dates };
}

function dateInSources(date, sourceText) {
 const m = MONTHS.indexOf(date.month) + 1;
 const forms = [`${date.month} ${date.day}`, `${date.month.slice(0, 3)} ${date.day}`, `${date.month.slice(0, 3)}. ${date.day}`, `${m}/${date.day}/`, `${String(m).padStart(2, '0')}/${String(date.day).padStart(2, '0')}/`, `-${String(m).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`, `${date.day} ${date.month}`];
 return forms.some(f => sourceText.includes(f));
}

export function checkAlert(markdown, sources, { today = new Date() } = {}) {
 const problems = [];
 const { meta, body } = parseFrontMatter(markdown);
 if (!meta) return ['The draft has no front matter.'];
 for (const k of ['title', 'seo_title', 'description', 'summary', 'keywords', 'type', 'published', 'updated']) if (!meta[k]) problems.push(`Front matter is missing ${k}.`);
 if (meta.type && meta.type !== 'Weekly alert') problems.push('type must be "Weekly alert".');
 if (!/^(true|yes)$/i.test(meta.draft || '')) problems.push('draft must be true until it is reviewed.');
 if (meta.seo_title && meta.seo_title.length > 60) problems.push(`seo_title is ${meta.seo_title.length} characters; the limit is 60.`);
 if (meta.description && (meta.description.length < 150 || meta.description.length > 155)) problems.push(`description is ${meta.description.length} characters; it must be 150 to 155.`);
 if (!/^\*\*Quick answer:\*\*/m.test(body)) problems.push('The quick answer paragraph is missing.');
 for (const h of ['Frequently asked questions', 'Sources']) if (!new RegExp(`^## ${h}`, 'mi').test(body)) problems.push(`The "${h}" section is missing.`);

 // Citations.
 const fetched = new Set(sources.map(s => normalizeUrl(s.url)));
 for (const m of body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
  const url = m[1];
  let host = '', path = '';
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname; } catch { problems.push(`This link isn't a valid address: ${url}`); continue; }
  if (host === 'joinsafekeep.com') continue;
  if (fetched.has(normalizeUrl(url))) continue;
  if (REFERENCE_SITES.includes(host) && (path === '/' || path === '')) continue;
  problems.push(`Cites a page that wasn't in this week's fetched sources: ${url}`);
 }

 // Numbers and dates.
 const sourceText = squash(sources.map(s => `${s.title || ''} ${s.text || ''}`).join(' \n '));
 const sourceDigits = digitsOnly(sourceText);
 let prose = squash(body.replace(/^## Sources[\s\S]*$/mi, ''));
 for (const r of REFERENCE_NUMBERS) prose = prose.replace(new RegExp(`(^|[^\\w-])${r.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '$1 ');
 const { numbers, dates } = numbersIn(prose);
 const missing = new Set();
 for (const n of numbers) {
  const bare = digitsOnly(n);
  if (!bare) continue;
  if (sourceDigits.includes(bare)) continue;
  missing.add(n);
 }
 for (const n of missing) problems.push(`The number ${n} doesn't appear in any fetched source.`);
 for (const d of dates) {
  if (d.year && Math.abs(Number(d.year) - today.getUTCFullYear()) > 1 && !sourceText.includes(d.year)) problems.push(`The date ${d.raw} doesn't appear in any fetched source.`);
  else if (!dateInSources(d, sourceText) && !(meta.published && d.raw.toLowerCase().startsWith(MONTHS[Number(meta.published.slice(5, 7)) - 1]) && d.day === Number(meta.published.slice(8, 10)))) problems.push(`The date ${d.raw} doesn't appear in any fetched source.`);
 }

 // House style.
 const text = squash(`${meta.title} ${meta.summary} ${meta.description} ${body}`);
 for (const phrase of AVOID_PHRASES) {
  const re = new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")}([^a-z]|$)`, 'i');
  if (re.test(text)) problems.push(`Uses "${phrase}", which STYLE.md asks us to avoid.`);
 }
 const flip = text.match(CONTRAST_FLIP);
 if (flip) problems.push(`Reads like a contrast flip, which STYLE.md asks us to avoid: "${flip[0]}"`);
 return [...new Set(problems)];
}
