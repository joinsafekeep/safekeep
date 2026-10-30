// The weekly alert email (PRD: Scam Alerts content engine > Send): the quick answer, the warning signs, what to do,
// and a link to the full post. Plain HTML, large type, one column, no images except the share card. The unsubscribe
// link is filled in per recipient by SendGrid substitution (-unsubscribe-), so one request can carry many people.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderAlertEmail(alert) {
 const subject = `Scam Alert: ${alert.title.replace(/^This Week['’]s Scam Alert:\s*/i, '').replace(/\s*\([^)]*\d{4}\)\s*$/, '')}`.slice(0, 120);
 const section = (s, fallback) => s ? `<h2 style="font-size:22px;margin:28px 0 8px">${esc(s.heading || fallback)}</h2><div>${s.html}</div>` : '';
 const html = `<!doctype html><html><body style="margin:0;background:#faf8f2"><div style="max-width:620px;margin:0 auto;padding:24px;font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.6;color:#203d39">
<p style="font-family:Arial,sans-serif;font-size:14px;letter-spacing:.12em;margin:0 0 6px">SAFEKEEP · THIS WEEK’S SCAM ALERT</p>
<h1 style="font-size:30px;line-height:1.2;font-weight:normal;margin:0 0 18px">${esc(alert.title)}</h1>
${alert.image && !/hero-video-poster/.test(alert.image) ? `<img src="${esc(alert.image)}" alt="" width="572" style="width:100%;height:auto;border-radius:10px;margin:0 0 18px">` : ''}
${alert.quick_answer ? `<p style="background:#eef5f0;border-radius:10px;padding:16px 18px;margin:0">${alert.quick_answer.html}</p>` : ''}
${section(alert.warning_signs, 'Warning signs')}
${section(alert.what_to_do, 'What to do')}
<p style="margin:30px 0"><a href="${esc(alert.url)}" style="display:inline-block;background:#24574b;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">Read the full alert</a></p>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#5b6f68;border-top:1px solid #d8dfd7;padding-top:16px">You’re getting this because you asked for Safekeep’s weekly Scam Alert. <a href="-unsubscribe-" style="color:#5b6f68">Unsubscribe from the weekly alert</a>. This doesn’t change any practice messages you’ve signed up for.<br>-footer-</p>
</div></body></html>`;
 const text = [alert.title, '', alert.quick_answer ? alert.quick_answer.text : '', '',
  alert.warning_signs ? `${alert.warning_signs.heading}\n${alert.warning_signs.text}` : '', '',
  alert.what_to_do ? `${alert.what_to_do.heading}\n${alert.what_to_do.text}` : '', '',
  `Read the full alert: ${alert.url}`, '', '--', 'You’re getting this because you asked for Safekeep’s weekly Scam Alert. Unsubscribe: -unsubscribe-', '-footer-'].join('\n').replace(/\n{3,}/g, '\n\n');
 return { subject, html, text };
}

export const unsubscribeUrl = (origin, email, sig) => `${origin}/scam-alerts/subscribe/?u=${encodeURIComponent(email)}&s=${sig}`;
export const oneClickUrl = (origin, email, sig) => `${origin}/api/alerts?u=${encodeURIComponent(email)}&s=${sig}`;
