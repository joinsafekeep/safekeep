import { familyReport, monthName } from '/practice/report.js';

// /r/<token>: the family web version of a monthly report. /r/?u=<recipient>&s=<signature>: stop getting it.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const match = location.pathname.match(/^\/r\/([0-9a-f]{48})\/?$/);
if (location.search) history.replaceState({}, '', location.pathname);
const post = async body => {
 const r = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const d = await r.json().catch(() => ({}));
 if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
 return d;
};
async function start() {
 if (params.get('u')) {
  $('status').textContent = ''; $('unsubscribe').hidden = false;
  $('unsubscribe-button').addEventListener('click', async () => {
   $('unsubscribe-button').disabled = true;
   try { const d = await post({ action: 'unsubscribe', rid: params.get('u'), sig: params.get('s') }); $('unsubscribe-status').textContent = d.saved ? 'Done. You won’t get this report any more.' : 'That link didn’t work. Reply to the report email and we’ll take you off.'; $('unsubscribe-button').hidden = d.saved; }
   catch (e) { $('unsubscribe-status').textContent = e.message; $('unsubscribe-button').disabled = false; }
  });
  return;
 }
 if (!match) { $('status').textContent = ''; $('gone').hidden = false; return; }
 const d = await post({ action: 'view', token: match[1] });
 if (!d.found) { $('status').textContent = ''; $('gone').hidden = false; return; }
 const r = d.report;
 $('eyebrow').textContent = r.kind === 'welcome' ? 'FIRST PRACTICES' : monthName(r.month).toUpperCase();
 $('title').textContent = r.kind === 'welcome' ? `${r.name} has started practising` : `${r.name}’s Safekeep report`;
 $('body').replaceChildren(...familyReport(r.metrics, r.name, { welcome: r.kind === 'welcome' }).paragraphs.map(t => { const p = document.createElement('p'); p.textContent = t; return p; }));
 $('status').textContent = ''; $('report').hidden = false;
}
start().catch(e => { $('status').textContent = e.message; });
