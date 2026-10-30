// Builds a practice email from a claimed row. Kept apart from the scheduled function so tests can check the wording,
// the footer rule and the headers without a database.
//
// Footer: the PRD's design shows "Safekeep practice message" on difficulty 1 and 2 only, and leaves open whether
// harder ones may go without it until counsel has read the CAN-SPAM header rules. Until then the footer shows on every
// practice email (PRACTICE_FOOTER=always, the default); set PRACTICE_FOOTER=easy_only once counsel agrees. Either
// way, every email carries the one-click stop link, the List-Unsubscribe headers and the postal address.
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function practiceConfig(env) {
 const missing = ['PRACTICE_EMAIL_DOMAIN', 'PRACTICE_POSTAL_ADDRESS'].filter(k => !env[k]);
 const linkOrigin = (env.PRACTICE_LINK_ORIGIN || env.APP_ORIGIN || '').replace(/\/$/, '');
 if (!linkOrigin) missing.push('PRACTICE_LINK_ORIGIN or APP_ORIGIN');
 // Practice mail must not share a domain with account and billing mail, or people learn to distrust the real ones.
 const accountDomain = (env.EMAIL_FROM || '').split('@')[1]?.toLowerCase();
 if (env.PRACTICE_EMAIL_DOMAIN && accountDomain && env.PRACTICE_EMAIL_DOMAIN.toLowerCase() === accountDomain) missing.push('a PRACTICE_EMAIL_DOMAIN different from the EMAIL_FROM domain');
 return { missing, linkOrigin, domain: env.PRACTICE_EMAIL_DOMAIN, postal: env.PRACTICE_POSTAL_ADDRESS, footerAlways: (env.PRACTICE_FOOTER || 'always') !== 'easy_only' };
}

export function buildPracticeEmail(row, config) {
 const variant = row.channel_variant || {};
 const link = `${config.linkOrigin}/p/${row.token}`;
 const stopPage = `${config.linkOrigin}/p/${row.token}?stop=1`;
 const oneClick = `${config.linkOrigin}/api/practice?stop=${row.token}`;
 const showLabel = config.footerAlways || row.difficulty <= 2;
 const body = String(row.content || '').replaceAll('{link}', link);
 const footerText = [showLabel ? 'Safekeep practice message' : null, `To stop these emails: ${stopPage}`, config.postal].filter(Boolean).join('\n');
 const text = `${body}\n\n--\n${footerText}\n`;
 const paragraphs = String(row.content || '').split(/\n{2,}/).map(p => {
  const html = escapeHtml(p).replace(/\n/g, '<br>').replaceAll('{link}', `<a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1a5fb4;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(variant.link_text || 'Open')}</a>`);
  return `<p style="margin:0 0 14px">${html}</p>`;
 }).join('');
 const footerHtml = `<p style="margin:28px 0 0;font-size:12px;color:#777">${showLabel ? 'Safekeep practice message<br>' : ''}<a href="${escapeHtml(stopPage)}" style="color:#777">Stop these emails</a><br>${escapeHtml(config.postal)}</p>`;
 const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:600px">${paragraphs}${footerHtml}</body></html>`;
 return {
  from: { email: `${variant.from_local || 'notices'}@${config.domain}`, name: variant.from_name || 'Notices' },
  subject: row.subject || '(no subject)', text, html,
  headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
 };
}

// SendGrid with click and open tracking switched off: a loaded pixel or a rewritten link is not evidence that a person
// was fooled, and the PRD rules out tracking pixels. custom_args carries the practice id to the event webhook.
export async function sendPracticeEmail({ apiKey, to, email, practiceId, idempotencyKey, fetcher = globalThis.fetch }) {
 const response = await fetcher('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
   personalizations: [{ to: [{ email: to }], custom_args: { practice_id: practiceId, idempotency_key: idempotencyKey } }],
   from: email.from, subject: email.subject, headers: email.headers, categories: ['practice'],
   content: [{ type: 'text/plain', value: email.text }, { type: 'text/html', value: email.html }],
   tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } }
  })
 });
 // A refusal here is almost always our configuration (domain, key), so it never suppresses the person's address.
 // Bounces from the address itself arrive later through the event webhook.
 if (!response.ok) throw new Error(`SendGrid ${response.status}`);
 return response.headers.get('x-message-id');
}
