import { renderCoaching } from '/practice/coaching.js';

// /p/<token>: the coaching page. The token comes from the path and stays there so the page survives a reload; the
// page sends no referrer, so it never leaks to the sites it links to.
const match = location.pathname.match(/^\/p\/([0-9a-f]{48})\/?$/);
const token = match ? match[1] : '';
const wantsStop = new URL(location.href).searchParams.get('stop') === '1';
if (location.search) history.replaceState({}, '', location.pathname);
const status = document.getElementById('status');
const root = document.getElementById('coaching');

async function call(body) {
 const response = await fetch('/api/practice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }), cache: 'no-store' });
 if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Safekeep isn’t available right now. Please try again in a few minutes.');
 const data = await response.json();
 if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
 return data;
}

// The footer's stop link: a confirm step and nothing else, so unsubscribing is never counted as opening the practice.
async function stopOnly() {
 const info = await call({ action: 'stop_info' });
 if (!info.found) { document.getElementById('gone').hidden = false; status.textContent = ''; return; }
 const kind = { email: 'emails', text: 'text messages', phone: 'calls' }[info.channel] || 'messages';
 const section = document.createElement('section'); section.className = 'stop'; section.id = 'stop';
 const h = document.createElement('h1'); h.textContent = `Stop practice ${kind}?`;
 const p = document.createElement('p'); p.textContent = info.active ? `We’ll stop sending you practice ${kind} here. Your account and any other practice you chose stay as they are, and you can turn this back on from your account page.` : `Practice ${kind} here are already off. You can turn them back on from your account page.`;
 const done = document.createElement('p'); done.setAttribute('role', 'status'); done.setAttribute('aria-live', 'polite');
 section.append(h, p);
 if (info.active) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = `Stop practice ${kind}`;
  button.addEventListener('click', async () => { button.disabled = true; try { done.textContent = await stopNow(); button.hidden = true; } catch (e) { done.textContent = e.message; button.disabled = false; } });
  section.append(button);
 }
 section.append(done);
 root.replaceChildren(section); status.textContent = '';
}

async function stopNow() {
 const r = await call({ action: 'stop' });
 if (!r.stopped) throw new Error('That didn’t work. You can turn practice off on your account page, or reply to any Safekeep email and we’ll do it for you.');
 return r.message;
}

async function start() {
 if (!token) { document.getElementById('gone').hidden = false; status.textContent = ''; return; }
 if (wantsStop) return stopOnly();
 const data = await call({ action: 'view' });
 if (!data.found) { document.getElementById('gone').hidden = false; status.textContent = ''; return; }
 status.textContent = '';
 const c = data.coaching;
 renderCoaching(root, c, {
  answer: async choice => call({ action: 'answer', choice }),
  share: async details => (await call({ action: 'share', ...details })).message,
  stop: c.shared ? null : stopNow
 });
 document.title = c.shared ? 'A practice scam to watch for | Safekeep' : 'This was a Safekeep practice | Safekeep';
}
start().catch(error => { status.textContent = error.message; status.classList.add('error'); });
