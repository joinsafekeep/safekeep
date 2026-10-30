import { markedMessage } from '/practice/coaching.js';

const $ = id => document.getElementById(id);
const message = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); } n.append(...kids.flat().filter(k => k != null)); return n; };
async function api(body) {
 const response = await fetch('/api/admin', { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
 const data = await response.json().catch(() => ({}));
 if (response.status === 401) return { signed_in: false };
 if (!response.ok) throw new Error(data.error || 'Something went wrong.');
 return data;
}
async function act(body) {
 document.querySelectorAll('button').forEach(b => b.disabled = true);
 try { const r = await api(body); await load(); message(r.message || 'Saved.'); } catch (e) { message(e.message, true); }
 finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
const when = iso => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

function draftCard(d) {
 const q = d.question || {};
 const variant = d.channel_variant || {};
 const editForm = el('form', { class: 'edit', hidden: '' },
  el('label', {}, 'Subject', el('input', { name: 'subject', value: d.subject || '' })),
  d.format === 'phone' ? el('div', {},
   el('label', {}, 'Opening (what the caller says first)', el('textarea', { name: 'opening', rows: '4' })),
   el('label', {}, 'Hook (must offer "press 1 or say yes")', el('textarea', { name: 'hook', rows: '2' })),
   el('label', {}, 'Pressure line (played once if they stay quiet)', el('textarea', { name: 'pressure', rows: '2' })))
   : el('label', {}, 'Message (keep {link} where the link goes)', el('textarea', { name: 'content', rows: '10' })),
  d.format === 'text' ? el('label', {}, 'Replies it listens for, separated by commas', el('input', { name: 'reply_keywords', value: (variant.reply_keywords || []).join(', ') })) : null,
  el('label', {}, 'Difficulty (1-5)', el('input', { name: 'difficulty', type: 'number', min: '1', max: '5', value: String(d.difficulty) })),
  el('label', {}, 'Why this one works on people', el('textarea', { name: 'debrief', rows: '4' })),
  el('label', {}, 'Warning signs, one per line as: quote | note', el('textarea', { name: 'tells', rows: '5' })),
  el('label', {}, 'What to do next time, one per line', el('textarea', { name: 'next_steps', rows: '3' })),
  el('button', { text: 'Save as a new draft' }));
 if (d.format === 'phone') { const sc = variant.script || {}; editForm.elements.opening.value = sc.opening || ''; editForm.elements.hook.value = sc.hook || ''; editForm.elements.pressure.value = sc.pressure || ''; }
 else editForm.elements.content.value = d.content || '';
 editForm.elements.debrief.value = d.debrief || '';
 editForm.elements.tells.value = (d.tells || []).map(t => `${t.quote} | ${t.note}`).join('\n');
 editForm.elements.next_steps.value = (d.next_steps || []).join('\n');
 editForm.addEventListener('submit', e => {
  e.preventDefault(); const f = editForm.elements;
  const channel_variant = d.format === 'phone' ? { script: { opening: f.opening.value, hook: f.hook.value, pressure: f.pressure.value } }
   : d.format === 'text' ? { reply_keywords: f.reply_keywords.value.split(',').map(k => k.trim()).filter(Boolean) } : variant;
  act({ action: 'edit', version_id: d.id, format: d.format, question: d.question, channel_variant, subject: f.subject.value, ...(d.format === 'phone' ? {} : { content: f.content.value }), difficulty: Number(f.difficulty.value), debrief: f.debrief.value,
   tells: f.tells.value.split('\n').filter(Boolean).map(line => { const [quote, ...rest] = line.split('|'); return { quote: quote.trim(), note: rest.join('|').trim() }; }),
   next_steps: f.next_steps.value.split('\n').map(s => s.trim()).filter(Boolean) });
 });
 const note = el('input', { placeholder: 'Reason, if rejecting (optional)', maxlength: '500' });
 const approve = el('button', { type: 'button', text: 'Approve and publish' });
 const reject = el('button', { type: 'button', class: 'secondary', text: 'Reject' });
 const edit = el('button', { type: 'button', class: 'secondary', text: 'Edit' });
 approve.onclick = () => act({ action: 'approve', version_id: d.id });
 reject.onclick = () => act({ action: 'reject', version_id: d.id, note: note.value });
 edit.onclick = () => { editForm.hidden = !editForm.hidden; };
 return el('article', { class: 'draft' },
  el('h3', { text: `${d.scam} (${d.format}, difficulty ${d.difficulty})` }),
  el('p', { class: 'meta', text: `${d.category} · ${d.code} · version ${d.version} · ${d.generated_by === 'human' ? 'written by hand' : 'drafted by the generator'} · ${when(d.created_at)}` }),
  el('div', { class: 'message' },
   d.format === 'email' ? el('div', { class: 'message-head' }, el('p', {}, el('span', { class: 'label', text: 'From: ' }), `${variant.from_name || ''} <${variant.from_local || 'notices'}@practice domain>`), el('p', {}, el('span', { class: 'label', text: 'Subject: ' }), d.subject || '')) : null,
   el('div', { class: 'message-body' }, markedMessage(d.content || '', d.tells))),
  el('h4', { text: 'Warning signs' }), el('ol', { class: 'tells' }, (d.tells || []).map(t => el('li', {}, el('q', { text: t.quote }), ' ', t.note))),
  el('h4', { text: 'What to do next time' }), el('ul', {}, (d.next_steps || []).map(s => el('li', { text: s }))),
  el('h4', { text: 'The question' }), el('p', { text: q.prompt || '(none)' }), el('ol', {}, (q.choices || []).map((c, i) => el('li', { text: `${c}${i === q.correct ? '  ✓' : ''}` }))),
  q.affirm ? el('p', { class: 'meta', text: `Right answer: ${q.affirm}` }) : null, q.gently ? el('p', { class: 'meta', text: `Other answers: ${q.gently}` }) : null,
  el('h4', { text: 'Why this one works on people' }), el('p', { text: d.debrief || '' }),
  el('div', { class: 'actions' }, approve, edit, reject, note), editForm);
}

async function load() {
 const data = await api();
 if (data.signed_in === false) { $('signed-out').hidden = false; $('admin').hidden = true; message(''); return; }
 $('admin').hidden = false;
 const lib = {}; for (const r of data.library || []) (lib[r.format] ||= {})[r.status] = r.count;
 $('library').textContent = ['email', 'text', 'phone'].map(f => `${f}: ${lib[f]?.published || 0} published, ${lib[f]?.draft || 0} drafts, ${lib[f]?.retired || 0} retired`).join(' · ');
 $('queue').replaceChildren(...(data.queue.length ? data.queue.map(draftCard) : [el('p', { text: 'Nothing waiting. Everything has been reviewed.' })]));
 $('deliveries').replaceChildren(...(data.deliveries || []).map(d => {
  const suppress = el('button', { type: 'button', class: 'secondary', text: 'Suppress' });
  suppress.onclick = () => { if (confirm(`Stop all practice to this ${d.channel === 'email' ? 'address' : 'number'}?`)) act({ action: 'suppress_contact', contact_id: d.contact_id }); };
  return el('tr', {}, el('td', { text: when(d.sent_at || d.scheduled_at) }), el('td', { text: d.email }), el('td', { text: d.channel }), el('td', { text: d.name }), el('td', { text: d.delivery_status }), el('td', { text: d.result }), el('td', { text: d.cancel_reason || d.failure_reason || '' }), el('td', {}, suppress));
 }));
 $('alerts').replaceChildren(...((data.alerts || []).length ? data.alerts.map(a => {
  const concerns = a.check_report?.problems?.length || 0;
  const note = concerns ? ` ${concerns} check concern${concerns === 1 ? '' : 's'}.` : '';
  const sent = a.status === 'sent' ? ` Sent to ${a.recipient_count}.` : a.status === 'sending' ? ` Sending: ${a.claimed} so far.` : '';
  return el('li', {}, `${a.week_of}: ${a.title || a.slug} (${a.status}).${note}${sent} `, a.pr_url ? el('a', { href: a.pr_url, target: '_blank', rel: 'noopener', text: 'Open the pull request' }) : null);
 }) : [el('li', { text: 'No alerts drafted yet.' })]));
 const m = data.metrics;
 if (m?.finished) {
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
  const table = (head, rows) => el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map(h => el('th', { text: h })))), el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', { text: String(c) })))))));
  $('metrics').replaceChildren(
   el('p', { text: `${m.finished} practices finished. Coaching completed on ${m.coaching_completion.coached} of ${m.coaching_completion.engaged} practice opportunities (${pct(m.coaching_completion.coached, m.coaching_completion.engaged)}). Median time from send to first response: ${m.median_minutes_to_first_event ?? '–'} minutes. Consent withdrawals: ${(m.withdrawals || []).map(w => `${w.channel} ${w.n}`).join(', ') || 'none'}.` }),
   el('h3', { text: 'By channel' }), table(['Channel', 'Finished', 'Opportunity rate', 'Spotted rate'], (m.by_channel || []).map(r => [r.channel, r.n, pct(r.engaged, r.n), pct(r.spotted, r.n)])),
   el('h3', { text: 'By difficulty' }), table(['Difficulty', 'Finished', 'Opportunity rate'], (m.by_difficulty || []).map(r => [r.difficulty, r.n, pct(r.engaged, r.n)])),
   el('h3', { text: 'By version' }), el('p', { class: 'meta', text: 'A version retires automatically once 20 or more have finished with under 5% practice opportunities.' }), table(['Scam', 'Channel', 'Version', 'Finished', 'Opportunity rate'], (m.by_version || []).slice(0, 30).map(r => [r.name, r.format, r.version, r.n, pct(r.engaged, r.n)])));
 }
 message(`Signed in as ${data.email}. ${data.queue.length} waiting for review.`);
}
$('draft-alert').addEventListener('click', () => act({ action: 'draft_alert' }));
load().catch(e => message(e.message, true));
