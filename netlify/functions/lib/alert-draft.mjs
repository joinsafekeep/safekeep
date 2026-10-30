// Drafting the weekly alert with Claude (PRD: Scam Alerts content engine > Draft). The model gets the house style,
// the keyword notes, the front-matter spec, the last four alerts and the week's fetched source text, and returns the
// article as markdown plus two to four candidate practice scams for the review queue.

export function weekOf(now = new Date()) {
 // The Monday of this week, in New York.
 const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
 const day = (local.getDay() + 6) % 7;
 local.setDate(local.getDate() - day);
 return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

export function buildPrompt({ style, keywords, frontMatterSpec, recent, sources, date, problems = null, previous = null }) {
 const system = `You write Safekeep's weekly Scam Alert for joinsafekeep.com. Readers are mostly 60 or older, or their grown children. Follow the house style guide exactly; it overrides your usual habits.

<style_guide>
${style}
</style_guide>

<keywords>
${keywords}
</keywords>

<front_matter_spec>
${frontMatterSpec}
</front_matter_spec>

Rules that the automated check enforces, so a draft that breaks them is rejected:
- Every factual sentence must come from the fetched sources below. Never add a statistic, date, dollar figure or count that isn't written in a source's text. If you are unsure of a number, leave it out.
- Cite with markdown links to the exact source URLs given below, and only those URLs. You may also point readers to these front pages for reporting: https://reportfraud.ftc.gov/, https://www.ic3.gov/, https://vote.gov/, https://www.identitytheft.gov/, https://www.medicare.gov/. The National Elder Fraud Hotline is 1-833-372-8311.
- Prefer primary sources (FBI, FTC, CFPB, state agencies, DOJ). Use news items only for things no agency published, and say whose report it is.
- seo_title at most 60 characters. description between 150 and 155 characters, counted exactly.
- Front matter must include draft: true, type: Weekly alert, published and updated set to ${date}.
- Impersonate no real company in the practice scams below; real agencies can be named in the article itself, because the article is reporting on them.`;

 const user = `Today is ${date}. Write this week's Scam Alert.

Pick one lead story: the most useful, best-sourced item this week for older adults and their families that the last four alerts didn't already lead with. Then a short "Also this week" section with two to four other items, each one or two sentences with its citation.

Use this structure, matching the recent alerts' format: front matter; a paragraph starting **Quick answer:**; "## What is/are ...?"; "## How do(es) ... work?"; "## What are the warning signs ...?"; "## What should you do if you get one?"; "## Also this week"; "## What to do if it already happened"; "## Frequently asked questions" with four or five "### question" headings each followed by one short paragraph; "## Sources" as a bullet list of the links you used. One line in the body may invite readers to [Sign up](#waitlist) for practice. Around 1,200 to 1,600 words.

Then propose two to four practice scams based on the lead story, at most one per channel (email, text, phone), for Safekeep's practice library. They impersonate roles ("your bank", "the county election office"), never a real company, agency or person by name, never ask for anything real, and never mention family members by name.

<recent_alerts>
${recent.map(r => `<alert slug="${r.slug}">\n${r.excerpt}\n</alert>`).join('\n')}
</recent_alerts>

<sources>
${sources.map((s, i) => `<source n="${i + 1}" publisher="${s.publisher}" kind="${s.kind || 'primary'}" url="${s.url}" published="${s.published_at || 'unknown'}">\n<title>${s.title}</title>\n${String(s.text).slice(0, 12000)}\n</source>`).join('\n')}
</sources>
${problems ? `
Your previous draft was rejected by the automated check for these reasons. Fix every one and return the whole thing again:
${problems.map(p => `- ${p}`).join('\n')}

<previous_draft>
${previous}
</previous_draft>
` : ''}
Return exactly two parts and nothing else:
<alert>
(the complete markdown file, starting with ---)
</alert>
<practice>
(a JSON array; each item: {"format":"email"|"text"|"phone","code":"lowercase-words-with-hyphens","name":"short name","category":"one word like bank, government, election, delivery","difficulty":1-5,"from_name":"(email only) role-based sender name","from_local":"(email only) like account-notices","subject":"(email only)","content":"the message; for email put {link} where the link goes; for text (under 230 characters) include {link} or a reply prompt; for phone leave empty","channel_variant":{"reply_keywords":["(text only) the replies it invites, never STOP, CANCEL, END, QUIT, HELP, START or REPORT"],"script":{"opening":"(phone only) two or three spoken sentences","hook":"(phone only) must offer 'press 1 or say yes'","pressure":"(phone only) one line of pressure"}},"tells":[{"quote":"exact words from content (for phone, from the script)","note":"one kind sentence on why it's a warning sign"}],"next_steps":["two or three things the person would say they'll do next time"],"learning_objective":"one sentence","debrief":"two or three sentences in the house style","question":{"prompt":"If this had been real, what would have been the first sign it wasn't?","choices":["three short choices"],"correct":0,"affirm":"one sentence","gently":"one sentence"}})
</practice>`;
 return { system, user };
}

export function parseDraft(text) {
 const alert = (String(text).match(/<alert>\s*([\s\S]*?)\s*<\/alert>/) || [])[1] || '';
 let practice = [];
 const raw = (String(text).match(/<practice>\s*([\s\S]*?)\s*<\/practice>/) || [])[1];
 if (raw) { try { const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); if (Array.isArray(parsed)) practice = parsed.slice(0, 4); } catch {} }
 return { markdown: alert.replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim() + '\n', practice };
}

export async function callClaude({ apiKey, model, system, user, fetcher = globalThis.fetch }) {
 const response = await fetcher('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
  signal: AbortSignal.timeout(600000)
 });
 if (!response.ok) throw new Error(`Claude API ${response.status}: ${(await response.text()).slice(0, 300)}`);
 const data = await response.json();
 return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// A short excerpt of a past alert for the prompt: the title, the quick answer, and the headings.
export function excerpt(markdown) {
 const title = (markdown.match(/^title:\s*(.*)$/m) || [])[1] || '';
 const quick = (markdown.match(/^\*\*Quick answer:\*\*.*$/m) || [''])[0];
 const also = (markdown.match(/## Also this week\n([\s\S]*?)\n## /) || [])[1] || '';
 return `${title}\n${quick}\nAlso this week: ${also.replace(/\]\([^)]*\)/g, ']').slice(0, 1200)}`;
}
