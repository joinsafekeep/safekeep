import { participantReport, familyReport, monthName } from '../../../practice/report.js';

// The monthly report emails (PRD: The report): large type, one column, under 400 words, a button to the web version,
// and a "new scams this month" block from the month's Scam Alerts. Plain text alongside every HTML version.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (inner, footer) => `<!doctype html><html><body style="margin:0;background:#faf8f2"><div style="max-width:620px;margin:0 auto;padding:24px;font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:1.6;color:#203d39">
<p style="font-family:Arial,sans-serif;font-size:14px;letter-spacing:.12em;margin:0 0 6px">SAFEKEEP</p>${inner}
<p style="font-family:Arial,sans-serif;font-size:14px;color:#5b6f68;border-top:1px solid #d8dfd7;padding-top:16px;margin-top:32px">${footer}</p></div></body></html>`;
const button = (href, label) => `<p style="margin:28px 0"><a href="${esc(href)}" style="display:inline-block;background:#24574b;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">${esc(label)}</a></p>`;
const paras = ps => ps.map(p => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('');

// The month's alerts, two or three at most: title, the quick answer, and a link.
function scamsBlock(alerts) {
 if (!alerts?.length) return { html: '', text: '' };
 const items = alerts.slice(0, 3);
 return {
  html: `<h2 style="font-size:23px;margin:30px 0 10px">New scams to know about</h2>${items.map(a => `<p style="margin:0 0 14px"><a href="${esc(a.url)}" style="color:#24574b;font-weight:bold">${esc(a.title.replace(/^This Week['’]s Scam Alert:\s*/i, ''))}</a><br>${esc(a.quick_answer?.text || a.description || '')}</p>`).join('')}`,
  text: `\nNew scams to know about\n${items.map(a => `- ${a.title.replace(/^This Week['’]s Scam Alert:\s*/i, '')}: ${a.url}`).join('\n')}\n`
 };
}

export function participantEmail({ report, name, site, alerts }) {
 const { paragraphs, opportunities } = participantReport(report.metrics, { welcome: report.kind === 'welcome' });
 const title = report.kind === 'welcome' ? 'How your first practices went' : `Your Safekeep report for ${monthName(report.month)}`;
 const opps = opportunities.length ? `<ul style="padding-left:22px;margin:0 0 14px">${opportunities.map(o => `<li>${esc(o.name)}</li>`).join('')}</ul>` : '';
 const scams = scamsBlock(alerts);
 const link = `${site}/account/#reports`;
 return {
  subject: title,
  html: shell(`<h1 style="font-size:30px;line-height:1.2;font-weight:normal;margin:0 0 18px">${esc(title)}</h1><p style="margin:0 0 14px">Hello ${esc(name || 'there')},</p>${paras(paragraphs)}${opps}${button(link, opportunities.length ? 'See what to look for' : 'See your report')}${scams.html}`,
   'You get this report because you practise with Safekeep. Choose who else receives it on your account page.'),
  text: `${title}\n\nHello ${name || 'there'},\n\n${paragraphs.join('\n\n')}\n${opportunities.map(o => `- ${o.name}`).join('\n')}\n\nSee your report: ${link}\n${scams.text}\n--\nYou get this report because you practise with Safekeep. Choose who else receives it on your account page.`
 };
}

export function familyBlock({ report, name, site, token }) {
 const { paragraphs } = familyReport(report.metrics, name, { welcome: report.kind === 'welcome' });
 const link = `${site}/r/${token}`;
 return { html: `${paras(paragraphs)}${button(link, `See ${name}’s report`)}`, text: `${paragraphs.join('\n\n')}\n\nSee ${name}’s report: ${link}` };
}

const familyFooter = (site, recipients) => recipients.map(r => `You get ${esc(r.participant)}’s report because ${esc(r.participant)} chose you as a reader. <a href="${esc(`${site}/r/?u=${r.recipient_id}&s=${r.sig}`)}" style="color:#5b6f68">Stop getting ${esc(r.participant)}’s report</a>.`).join('<br>');
const familyFooterText = (site, recipients) => recipients.map(r => `You get ${r.participant}’s report because ${r.participant} chose you as a reader. Stop getting it: ${site}/r/?u=${r.recipient_id}&s=${r.sig}`).join('\n');

export function familyEmail({ report, name, readerName, site, token, alerts, recipient }) {
 const block = familyBlock({ report, name, site, token });
 const title = report.kind === 'welcome' ? `${name} has started practising with Safekeep` : `${name}’s Safekeep report for ${monthName(report.month)}`;
 const scams = scamsBlock(alerts);
 const recipients = [{ participant: name, recipient_id: recipient.recipient_id, sig: recipient.sig }];
 return {
  subject: title,
  html: shell(`<h1 style="font-size:30px;line-height:1.2;font-weight:normal;margin:0 0 18px">${esc(title)}</h1><p style="margin:0 0 14px">Hello ${esc(readerName || 'there')},</p>${block.html}${scams.html}`, familyFooter(site, recipients)),
  text: `${title}\n\nHello ${readerName || 'there'},\n\n${block.text}\n${scams.text}\n--\n${familyFooterText(site, recipients)}`
 };
}

// One email for a sponsor covering each participant who chose them, a short block each.
export function sponsorEmail({ month, blocks, site, alerts }) {
 const names = blocks.map(b => b.participant_name);
 const title = `Your family’s Safekeep report for ${monthName(month)}`;
 const scams = scamsBlock(alerts);
 const recipients = blocks.map(b => ({ participant: b.participant_name, recipient_id: b.recipient_id, sig: b.sig }));
 return {
  subject: title,
  html: shell(`<h1 style="font-size:30px;line-height:1.2;font-weight:normal;margin:0 0 18px">${esc(title)}</h1><p style="margin:0 0 14px">Hello,</p><p style="margin:0 0 14px">Here’s how practice went this month for ${esc(names.join(' and '))}.</p>${blocks.map(b => `<h2 style="font-size:23px;margin:26px 0 10px">${esc(b.participant_name)}</h2>${b.block_html}`).join('')}${scams.html}`, familyFooter(site, recipients)),
  text: `${title}\n\nHello,\n\n${blocks.map(b => `${b.participant_name}\n${b.block_text}`).join('\n\n')}\n${scams.text}\n--\n${familyFooterText(site, recipients)}`
 };
}

export const wordCount = s => String(s).replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
