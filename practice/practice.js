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

async function start() {
 if (!token) { document.getElementById('gone').hidden = false; status.textContent = ''; return; }
 const data = await call({ action: 'view' });
 if (!data.found) { document.getElementById('gone').hidden = false; status.textContent = ''; return; }
 status.textContent = '';
 const c = data.coaching;
 renderCoaching(root, c, {
  answer: async choice => call({ action: 'answer', choice }),
  share: async details => (await call({ action: 'share', ...details })).message,
  stop: c.shared ? null : async () => (await call({ action: 'stop' })).message
 });
 document.title = c.shared ? 'A practice scam to watch for | Safekeep' : 'This was a Safekeep practice | Safekeep';
 if (wantsStop) document.getElementById('stop')?.scrollIntoView();
}
start().catch(error => { status.textContent = error.message; status.classList.add('error'); });
