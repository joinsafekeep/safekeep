import test from 'node:test';
import assert from 'node:assert/strict';
import { twilioSignature, validTwilioRequest } from '../netlify/functions/lib/twilio.mjs';
import { quickRead, classifyReply } from '../netlify/functions/lib/distress.mjs';
import { makeHandler as smsHandler, MESSAGES } from '../netlify/functions/practice-sms.mjs';
import { makeHandler as voiceHandler } from '../netlify/functions/practice-voice.mjs';
import { runPractice, practiceText, channelStatus } from '../netlify/functions/scheduled-practice.mjs';

const AUTH = 'test-auth-token';
const env = { APP_ORIGIN: 'https://joinsafekeep.com', PRACTICE_LINK_ORIGIN: 'https://practice.joinsafekeep.com', SUPABASE_SERVICE_ROLE_KEY: 'k', TWILIO_AUTH_TOKEN: AUTH, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 's', TWILIO_MESSAGING_SERVICE_SID: 'MG1', TWILIO_VOICE_NUMBER: '+15550000000' };
const PID = '11111111-1111-4111-8111-111111111111';

function signed(url, params) {
 return new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(AUTH, url, params) }, body: new URLSearchParams(params) });
}

test('Twilio signatures: the documented algorithm, and a changed parameter fails', () => {
 // The example from Twilio's security documentation.
 const url = 'https://example.com/myapp.php?foo=1&bar=2';
 const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
 assert.equal(twilioSignature('12345', url, params), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
 assert.equal(validTwilioRequest({ authToken: '12345', urls: [url], params, signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=' }), true);
 assert.equal(validTwilioRequest({ authToken: '12345', urls: [url], params: { ...params, Digits: '9' }, signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=' }), false);
});

test('distress reading: worried words decide alone, expected answers pass, and the model is asked when unsure', async () => {
 assert.equal(quickRead('who is this? im scared'), 'distress');
 assert.equal(quickRead('Please stop texting me'), 'distress');
 assert.equal(quickRead('YES', ['yes']), 'ok');
 assert.equal(quickRead('$600'), 'ok');
 assert.equal(quickRead('what do I need to do'), null);
 assert.equal(await classifyReply({ text: 'what do I need to do' }), 'distress', 'no model configured: err on the side of care');
 const okModel = async () => Response.json({ content: [{ type: 'text', text: 'OK' }] });
 assert.equal(await classifyReply({ text: 'what do I need to do', apiKey: 'a', fetcher: okModel }), 'ok');
 assert.equal(await classifyReply({ text: 'what do I need to do', apiKey: 'a', fetcher: async () => new Response('', { status: 500 }) }), 'distress');
});

function fakeDb(practice = { practice_id: PID, user_id: 'u', result: 'pending', reply_keywords: ['yes'] }) {
 const calls = [];
 return { calls, makeClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); if (name === 'practice_for_text_reply') return { data: practice ? [practice] : [], error: null }; if (name === 'record_text_reply') return { data: { token: 'ab'.repeat(24), result: 'engaged' }, error: null }; return { data: null, error: null }; } }) };
}

test('text replies: STOP withdraws consent, REPORT is spotted, a reply gets the coaching link, worry gets the reassurance', async () => {
 const db = fakeDb();
 const handler = smsHandler({ env, makeClient: db.makeClient, fetcher: async () => { throw new Error('no model'); } });
 const url = 'https://joinsafekeep.com/api/practice/sms';
 const send = Body => handler(signed(url, { From: '+15555550101', Body, MessageSid: `SM${Body.length}` }));
 assert.equal((await handler(new Request(url, { method: 'POST', headers: { 'x-twilio-signature': 'nope' }, body: 'From=%2B1&Body=hi' }))).status, 403);
 assert.equal(await (await send('STOP')).text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
 assert.deepEqual(db.calls.at(-1), { name: 'stop_texts_from', args: { from_number: '+15555550101' } });
 assert.match(await (await send('report')).text(), /You spotted it/);
 assert.equal(db.calls.find(c => c.name === 'record_text_reply').args.kind, 'report');
 const reply = await (await send('YES')).text();
 assert.match(reply, /You did nothing wrong/); assert.match(reply, /https:\/\/practice\.joinsafekeep\.com\/p\/abab/);
 const worried = await (await send('who is this, I am frightened')).text();
 assert.match(worried, /Someone from our team will check in with you today/);
 assert.equal(db.calls.filter(c => c.name === 'record_text_reply').at(-1).args.kind, 'distress');
 // A reply that isn't clearly either, with no model available, is treated with care.
 await send('what do I need to do');
 assert.equal(db.calls.filter(c => c.name === 'record_text_reply').at(-1).args.kind, 'distress');
 assert.ok(!/fail|fell for|victim/i.test(Object.values(MESSAGES).map(m => m('x')).join(' ')));
});

test('text delivery reports: delivered, a bad number suppresses, an opted-out number counts as STOP', async () => {
 const db = fakeDb();
 const handler = smsHandler({ env, makeClient: db.makeClient });
 const url = `https://joinsafekeep.com/api/practice/sms-status?p=${PID}`;
 await handler(signed(url, { MessageSid: 'SM9', MessageStatus: 'delivered', To: '+15555550101' }));
 assert.deepEqual(db.calls.at(-1), { name: 'mark_practice_delivered', args: { pid: PID, provider_event: 'SM9:delivered' } });
 await handler(signed(url, { MessageSid: 'SM9', MessageStatus: 'undelivered', ErrorCode: '30006', To: '+15555550101' }));
 assert.equal(db.calls.at(-1).args.permanent, true);
 await handler(signed(url, { MessageSid: 'SM9', MessageStatus: 'undelivered', ErrorCode: '21610', To: '+15555550101' }));
 assert.equal(db.calls.at(-1).name, 'stop_texts_from');
});

function voiceDb({ canText = true, revealed = false } = {}) {
 const calls = [];
 return { calls, makeClient: () => ({ rpc: async (name, args) => {
  calls.push({ name, args });
  if (name === 'call_script') return { data: { practice_id: PID, revealed, can_text: canText, text_to: '+15555550101', script: { opening: 'This is the account security team.', hook: 'Press 1 or say yes.', pressure: 'Your account will close.' }, tells: [{ quote: 'q', note: 'It never says which bank.' }], next_steps: ['I will call the number on my card.'] }, error: null };
  if (name === 'record_call_event' && args.event === 'link') return { data: { token: 'cd'.repeat(24) }, error: null };
  return { data: { saved: true }, error: null };
 } }) };
}
const voiceUrl = step => `https://joinsafekeep.com/api/practice/voice?p=${PID}&step=${step}`;

test('calls: voicemail hangs up, a person hears the hook, pressing 1 brings the reveal in another voice', async () => {
 const db = voiceDb(); const texts = [];
 const handler = voiceHandler({ env, makeClient: db.makeClient, fetcher: async (url, init) => { texts.push(Object.fromEntries(new URLSearchParams(init.body))); return Response.json({ sid: 'SM1' }); } });
 assert.equal(await (await handler(signed(voiceUrl('start'), { CallSid: 'CA1', AnsweredBy: 'machine_start' }))).text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
 const start = await (await handler(signed(voiceUrl('start'), { CallSid: 'CA1', AnsweredBy: 'human' }))).text();
 assert.match(start, /<Gather input="dtmf speech"/); assert.match(start, /Press 1 or say yes/); assert.match(start, /step=answer1/);
 assert.equal(db.calls.filter(c => c.name === 'record_call_event').at(-1).args.event, 'answered');
 const reveal = await (await handler(signed(voiceUrl('answer1'), { CallSid: 'CA1', Digits: '1' }))).text();
 assert.match(reveal, /voice="Polly.Joanna">This is Safekeep. That was a practice call, not a real one, and you did nothing wrong/);
 assert.match(reveal, /First: It never says which bank/); assert.match(reveal, /press 1/i);
 assert.deepEqual(db.calls.filter(c => c.name === 'record_call_event').map(c => c.args.event).slice(-2), ['hook', 'revealed']);
 const sent = await (await handler(signed(voiceUrl('after'), { CallSid: 'CA1', Digits: '1' }))).text();
 assert.match(sent, /Sent/);
 assert.equal(texts[0].To, '+15555550101'); assert.match(texts[0].Body, /https:\/\/practice\.joinsafekeep\.com\/p\/cdcd/);
});

test('calls: silence gets the pressure line once and then counts as the hook; no or another key is spotted; 9 stops', async () => {
 const db = voiceDb({ canText: false });
 const handler = voiceHandler({ env, makeClient: db.makeClient });
 assert.match(await (await handler(signed(voiceUrl('answer1'), { CallSid: 'CA2' }))).text(), /step=answer2.*Your account will close/s);
 const stayed = await (await handler(signed(voiceUrl('answer2'), { CallSid: 'CA2' }))).text();
 assert.match(stayed, /you did nothing wrong/); assert.match(stayed, /account page/);
 const refused = await (await handler(signed(voiceUrl('answer1'), { CallSid: 'CA3', SpeechResult: 'No, this is a scam' }))).text();
 assert.match(refused, /you handled it well/);
 assert.ok(db.calls.some(c => c.args?.event === 'refused'));
 const stop = await (await handler(signed(voiceUrl('answer1'), { CallSid: 'CA4', Digits: '9' }))).text();
 assert.match(stop, /won&apos;t get any more practice calls/);
 assert.equal(db.calls.filter(c => c.name === 'record_call_event').at(-1).args.event, 'stop');
 await handler(signed(voiceUrl('status'), { CallSid: 'CA2', CallStatus: 'completed', CallDuration: '41', AnsweredBy: 'human' }));
 assert.deepEqual(db.calls.at(-1).args, { pid: PID, event: 'ended', call_sid: 'CA2', duration: 41, answered_by: 'human' });
 await handler(signed(voiceUrl('status'), { CallSid: 'CA5', CallStatus: 'no-answer' }));
 assert.equal(db.calls.at(-1).args.duration, null);
});

test('sending texts and calls: only when switched on, with the footer, status callbacks and answered-by detection', async () => {
 assert.deepEqual(channelStatus({ ...env }).on, [], 'nothing sends until each channel is switched on');
 const on = { ...env, PRACTICE_TEXT: 'on', PRACTICE_CALLS: 'on' };
 assert.deepEqual(channelStatus(on).on, ['text', 'phone']);
 assert.match(practiceText({ content: 'Pay here: {link}', token: 'ef'.repeat(24), difficulty: 4 }, { linkOrigin: 'https://practice.joinsafekeep.com', footerAlways: true }), /p\/efef.*\n\nSafekeep practice\. Reply STOP to stop\.$/s);
 assert.ok(!/Safekeep/.test(practiceText({ content: 'Hi {link}', token: 'x', difficulty: 4 }, { linkOrigin: 'o', footerAlways: false })));
 const rpcs = [], posts = [];
 const client = { rpc: async (name, args) => { rpcs.push({ name, args }); if (name === 'claim_due_practices') return { data: args.ch === 'text' ? [{ practice_id: PID, address: '+15555550101', token: 'ab'.repeat(24), difficulty: 1, content: 'Hi {link}' }] : [{ practice_id: PID, address: '+15555550102', extension: '12', difficulty: 1 }], error: null }; return { data: 0, error: null }; } };
 const fetcher = async (url, init) => { posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) }); return Response.json({ sid: url.includes('Calls') ? 'CA1' : 'SM1' }); };
 const result = await runPractice({ env: on, makeClient: () => client, fetcher });
 assert.deepEqual(result.channels, ['text', 'phone']);
 assert.deepEqual(rpcs.find(r => r.name === 'plan_practices').args, { channels: ['text', 'phone'] });
 const sms = posts.find(p => p.url.endsWith('/Messages.json')).body;
 assert.equal(sms.MessagingServiceSid, 'MG1'); assert.equal(sms.StatusCallback, `https://joinsafekeep.com/api/practice/sms-status?p=${PID}`);
 const call = posts.find(p => p.url.endsWith('/Calls.json')).body;
 assert.equal(call.MachineDetection, 'Enable'); assert.equal(call.Record, 'false'); assert.equal(call.SendDigits, 'ww12'); assert.equal(call.From, '+15550000000');
 assert.equal(call.Url, `https://joinsafekeep.com/api/practice/voice?p=${PID}&step=start`);
 assert.deepEqual(rpcs.filter(r => r.name === 'mark_practice_sent').map(r => r.args.provider_id), ['SM1', 'CA1']);
});

test('a worried reply that asks to stop also stops practice texts', async () => {
 const db = fakeDb();
 const handler = smsHandler({ env, makeClient: db.makeClient, fetcher: async () => { throw new Error('no model'); } });
 const reply = await (await handler(signed('https://joinsafekeep.com/api/practice/sms', { From: '+15555550101', Body: 'Please stop texting me, I am scared', MessageSid: 'SMx' }))).text();
 assert.match(reply, /We&apos;ve stopped practice texts to this number/);
 assert.deepEqual(db.calls.map(c => c.name).slice(-2), ['record_text_reply', 'stop_texts_from']);
});

test('admin edits of a call carry the new script into what the call says, and are checked like the library', async () => {
 const { makeHandler } = await import('../netlify/functions/admin.mjs');
 const calls = [];
 const createClient = () => ({ auth: { getUser: async () => ({ data: { user: { id: 'a', email: 'ian@example.com', email_confirmed_at: 'x' } }, error: null }) }, rpc: async (n, a) => { calls.push({ n, a }); return { data: n === 'am_i_admin' ? true : { saved: true, version_id: 'v2' }, error: null }; } });
 const handler = makeHandler({ env: { APP_ORIGIN: 'https://joinsafekeep.com' }, createClient });
 const post = body => handler(new Request('https://joinsafekeep.com/api/admin', { method: 'POST', headers: { origin: 'https://joinsafekeep.com', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
 const base = { action: 'edit', version_id: '22222222-2222-4222-8222-222222222222', format: 'phone', difficulty: 2, debrief: 'A calm debrief.', next_steps: ['I will hang up.', 'I will call my bank.'], question: { prompt: 'Q?', choices: ['a', 'b', 'c'], correct: 0, affirm: 'Yes.', gently: 'Close.' }, tells: [{ quote: 'the security team', note: 'No bank name.' }, { quote: 'press 1', note: 'The hook.' }] };
 const ok = await post({ ...base, channel_variant: { script: { opening: 'This is the security team.', hook: 'To fix it, press 1 or say yes.', pressure: 'It closes today.' } } });
 assert.equal(ok.status, 200);
 const saved = calls.at(-1).a.payload;
 assert.equal(saved.channel_variant.script.hook, 'To fix it, press 1 or say yes.');
 assert.equal(saved.content, 'This is the security team.\n\nTo fix it, press 1 or say yes.\n\nIt closes today.');
 const branded = await post({ ...base, channel_variant: { script: { opening: 'This is the Chase security team.', hook: 'To fix it, press 1 or say yes.', pressure: 'It closes today.' } } });
 assert.equal(branded.status, 400); assert.match((await branded.json()).error, /real brand/);
});
