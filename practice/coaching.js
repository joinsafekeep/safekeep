// Renders a coaching page into a container. Used by /p/<token> and by the account page's history, so both show the
// same thing. Everything is built as DOM nodes from data; nothing from the server is inserted as HTML.
const el = (tag, attrs = {}, ...children) => {
 const node = document.createElement(tag);
 for (const [k, v] of Object.entries(attrs)) {
  if (v === null || v === undefined || v === false) continue;
  if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node.setAttribute(k, v === true ? '' : v);
 }
 for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
 return node;
};

// The message with each warning sign marked and numbered. Quotes are matched word for word, first occurrence, and
// overlapping ones are dropped rather than nested.
export function markedMessage(content, tells) {
 const found = [];
 (tells || []).forEach((t, i) => {
  const at = content.indexOf(t.quote);
  if (at >= 0) found.push({ start: at, end: at + t.quote.length, n: i + 1 });
 });
 found.sort((a, b) => a.start - b.start);
 const spans = []; let last = 0;
 for (const f of found) { if (f.start < last) continue; spans.push(f); last = f.end; }
 const out = []; let pos = 0;
 const plain = text => text.split('{link}').flatMap((part, i) => i ? [el('span', { class: 'fake-link', text: 'link' }), part] : [part]).filter(p => p !== '');
 for (const s of spans) {
  out.push(...plain(content.slice(pos, s.start)));
  out.push(el('mark', { id: `tell-${s.n}` }, content.slice(s.start, s.end), el('sup', { text: String(s.n), 'aria-label': `warning sign ${s.n}` })));
  pos = s.end;
 }
 out.push(...plain(content.slice(pos)));
 return out;
}

const channelWords = { email: 'email', text: 'text message', phone: 'call' };

export function renderCoaching(root, c, { answer, share, stop } = {}) {
 root.replaceChildren();
 const kind = channelWords[c.channel] || 'message';
 const spotted = c.result === 'reported';
 // Reassurance first.
 if (c.shared) {
  root.append(el('section', { class: 'reassure' },
   el('h1', { text: `Here’s a practice scam ${kind}, with the warning signs marked` }),
   el('p', { text: 'Someone in your family practises spotting scams with Safekeep and wanted to show you this one. It was a practice message, so nothing happened to anyone’s money or information. The real ones work the same way, which is why it’s worth a look.' })));
 } else if (spotted) {
  root.append(el('section', { class: 'reassure' },
   el('h1', { text: 'You spotted it' }),
   el('p', { text: `This ${kind} was a practice from Safekeep, and checking before doing anything was exactly the right move. Here’s a quick look at what gave it away, in case a real one comes along.` })));
 } else {
  root.append(el('section', { class: 'reassure' },
   el('h1', { text: `This was a practice ${kind} from Safekeep` }),
   el('p', { class: 'big', text: 'Nothing happened to your money or your information.' }),
   el('p', { text: 'Plenty of careful people open messages like this one, because they’re made to look ordinary. Take a minute with the parts we’ve marked below, and you’ll know them next time.' })));
 }
 // The message, replayed.
 const head = c.format === 'email' ? el('div', { class: 'message-head' },
  c.from_name ? el('p', {}, el('span', { class: 'label', text: 'From: ' }), c.from_name) : null,
  c.subject ? el('p', {}, el('span', { class: 'label', text: 'Subject: ' }), c.subject) : null) : null;
 const notes = el('ol', { class: 'tells' }, (c.tells || []).map((t, i) => el('li', { id: `note-${i + 1}` }, el('q', { text: t.quote }), ' ', t.note)));
 root.append(el('section', {},
  el('h2', { text: c.shared ? 'The message' : `The ${kind} you got` }),
  el('div', { class: 'message', role: 'figure', 'aria-label': `The practice ${kind}` }, head, el('div', { class: 'message-body' }, markedMessage(c.content || '', c.tells))),
  el('h3', { text: 'What gave it away' }), notes));
 // What to do next time.
 if (c.next_steps?.length) root.append(el('section', {}, el('h2', { text: 'What to do next time' }), el('ul', { class: 'steps' }, c.next_steps.map(s => el('li', { text: s })))));
 if (c.debrief) root.append(el('section', {}, el('h2', { text: 'Why this one works on people' }), el('p', { text: c.debrief })));
 // One question.
 if (c.question && answer) {
  const result = el('p', { class: 'answer', role: 'status', 'aria-live': 'polite' });
  const buttons = c.question.choices.map((choice, i) => el('button', { type: 'button', class: 'choice-button', 'data-i': String(i), text: choice }));
  const settle = (r, chosen) => {
   buttons.forEach((b, i) => { b.disabled = true; b.classList.toggle('right', i === r.correct_index); b.classList.toggle('chosen', i === chosen); });
   result.textContent = r.message || '';
  };
  buttons.forEach((b, i) => b.addEventListener('click', async () => {
   buttons.forEach(x => x.disabled = true);
   try { settle(await answer(i), i); } catch (e) { buttons.forEach(x => x.disabled = false); result.textContent = e.message; }
  }));
  root.append(el('section', {}, el('h2', { text: 'One quick question' }), el('p', { text: c.question.prompt }), el('div', { class: 'choices' }, buttons), result));
  if (c.answer) settle(c.answer, null);
 }
 // Share.
 if (share && c.can_share) {
  const status = el('p', { role: 'status', 'aria-live': 'polite' });
  const form = el('form', { class: 'share' },
   el('div', { class: 'columns' },
    el('label', {}, 'Their first name', el('input', { name: 'to_name', maxlength: '80', autocomplete: 'off' })),
    el('label', {}, 'Their email', el('input', { name: 'to_email', type: 'email', maxlength: '254', required: true, autocomplete: 'off' }))),
   el('label', {}, 'Your name, so they know who it’s from', el('input', { name: 'from_name', maxlength: '80', autocomplete: 'given-name' })),
   el('button', { text: 'Send this page' }), status);
  form.addEventListener('submit', async event => {
   event.preventDefault(); if (!form.reportValidity()) return;
   const button = form.querySelector('button'); button.disabled = true;
   try { status.textContent = await share({ to_name: form.elements.to_name.value, to_email: form.elements.to_email.value, from_name: form.elements.from_name.value }); form.reset(); }
   catch (e) { status.textContent = e.message; } finally { button.disabled = false; }
  });
  root.append(el('section', {}, el('h2', { text: 'Show someone in the family' }),
   el('p', { text: 'Explaining a scam to someone else is one of the best ways to remember it. We’ll email them a link to this page, without your result. You can share it with up to three people.' }), form));
 }
 if (c.context_url) root.append(el('p', { class: 'context' }, 'More about this kind of scam: ', el('a', { href: c.context_url, text: 'read the Safekeep guide' })));
 if (stop) {
  const btn = el('button', { type: 'button', class: 'secondary', text: `Stop practice ${kind === 'call' ? 'calls' : kind + 's'} to this ${c.channel === 'email' ? 'address' : 'number'}` });
  const status = el('p', { role: 'status', 'aria-live': 'polite' });
  btn.addEventListener('click', async () => { btn.disabled = true; try { status.textContent = await stop(); btn.hidden = true; } catch (e) { status.textContent = e.message; btn.disabled = false; } });
  root.append(el('section', { class: 'stop', id: 'stop' }, el('h2', { text: 'Want to stop?' }), el('p', { text: 'That’s fine. This stops practice on this channel only. Your account and other channels stay as they are, and you can turn it back on from your account page.' }), btn, status));
 }
}
