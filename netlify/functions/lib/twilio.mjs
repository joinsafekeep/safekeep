import { createHmac, timingSafeEqual } from 'node:crypto';

// Twilio for practice texts and calls: sending, placing calls, checking that a webhook really came from Twilio, and
// writing TwiML. Credentials: a restricted API key (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET) or the account SID and
// auth token. Webhook signatures are always made with the auth token, so TWILIO_AUTH_TOKEN is needed to receive.
export function twilioAuth(env) {
 if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) return 'Basic ' + Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString('base64');
 if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) return 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
 return null;
}

async function post(env, path, params, fetcher) {
 const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/${path}`, { method: 'POST', headers: { Authorization: twilioAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
 const data = await response.json().catch(() => ({}));
 if (!response.ok) throw new Error(`Twilio ${response.status}${data.code ? ` ${data.code}` : ''}`);
 return data;
}

// One Messaging Service with a sticky sender, so each participant always hears from the same Safekeep number and
// STOP (Advanced Opt-Out) applies to it.
export const sendSms = ({ env, to, body, statusCallback, fetcher = globalThis.fetch }) =>
 post(env, 'Messages.json', { To: to, Body: body, MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, ...(statusCallback ? { StatusCallback: statusCallback } : {}) }, fetcher);

// A call from Safekeep's own number (registered caller name, never spoofed), answered-by detection on so no voicemail
// is ever left, a 25-second ring, and no recording.
export const placeCall = ({ env, to, extension, url, statusCallback, fetcher = globalThis.fetch }) =>
 post(env, 'Calls.json', { To: to, From: env.TWILIO_VOICE_NUMBER, Url: url, Method: 'POST', StatusCallback: statusCallback, StatusCallbackMethod: 'POST', MachineDetection: 'Enable', Timeout: '25', Record: 'false', ...(extension ? { SendDigits: `ww${String(extension).replace(/\D/g, '')}` } : {}) }, fetcher);

// X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by each POST parameter name and value, sorted by name.
export function twilioSignature(authToken, url, params) {
 const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
 return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
export function validTwilioRequest({ authToken, urls, params, signature }) {
 if (!authToken || !signature) return false;
 const given = Buffer.from(signature);
 return urls.some(url => { const want = Buffer.from(twilioSignature(authToken, url, params)); return want.length === given.length && timingSafeEqual(want, given); });
}

// Reads a Twilio webhook: form fields, plus the URLs Twilio may have signed (the public origin and the one the
// function sees can differ behind the CDN).
export async function readTwilioWebhook(request, env) {
 const raw = await request.text();
 const params = Object.fromEntries(new URLSearchParams(raw));
 const seen = new URL(request.url);
 const urls = [seen.toString()];
 for (const origin of [env.APP_ORIGIN, env.URL].filter(Boolean)) urls.push(new URL(seen.pathname + seen.search, origin).toString());
 const ok = validTwilioRequest({ authToken: env.TWILIO_AUTH_TOKEN, urls: [...new Set(urls)], params, signature: request.headers.get('x-twilio-signature') });
 return { ok, params, url: seen };
}

export const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export const twiml = inner => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { headers: { 'Content-Type': 'text/xml' } });
