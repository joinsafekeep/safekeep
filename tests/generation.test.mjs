import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerate, buildGeneratePrompt } from '../netlify/functions/practice-generate-background.mjs';
import { startGenerateJob } from '../netlify/functions/scheduled-generate.mjs';

const good = [
 { format: 'email', code: 'pharmacy-refill', name: 'Pharmacy refill hold', category: 'health', difficulty: 3, from_name: 'Pharmacy Notices', from_local: 'rx-notices', subject: 'Your prescription is on hold', content: 'Your refill is on hold until you confirm your insurance number: {link}', tells: [{ quote: 'on hold', note: 'A real pharmacy calls or texts from a number you know.' }, { quote: 'confirm your insurance number', note: 'Your insurance number is valuable for billing fraud.' }], next_steps: ['I will call my pharmacy on the number on my bottle.', 'I will not type my insurance number into a link.'], learning_objective: 'x', debrief: 'Pharmacy holds are believable, which is why they work.', question: { prompt: 'Q?', choices: ['a', 'b', 'c'], correct: 1, affirm: 'Yes.', gently: 'Close.' } },
 { format: 'phone', code: 'delivery-redelivery-fee', name: 'Parcel call again', category: 'delivery', difficulty: 2, channel_variant: { script: { opening: 'This is the parcel depot.', hook: 'Press 1 or say yes to pay the fee.', pressure: 'It goes back today.' } }, tells: [{ quote: 'parcel depot', note: 'No company name.' }, { quote: 'pay the fee', note: 'Carriers do not call for fees.' }], next_steps: ['I will hang up.', 'I will check tracking myself.'], learning_objective: 'x', debrief: 'y', question: { prompt: 'Q?', choices: ['a', 'b', 'c'], correct: 0, affirm: 'Yes.', gently: 'Close.' } },
 { format: 'text', code: 'bad-brand', name: 'Netflix payment', category: 'shopping', difficulty: 2, content: 'Netflix: payment failed, update here {link}', tells: [], next_steps: [], question: null }
];

test('the generator asks for six drafts from the alert, leftovers and gaps, and queues only those that pass the check', async () => {
 const inserted = { practice_scams: [], practice_scam_versions: [] };
 let prompt;
 const db = {
  rpc: async name => ({ data: name === 'library_gaps' ? { categories: [{ category: 'delivery', published: { email: 1, text: 1, phone: 0 }, opportunity_rate: 0.02 }], codes: ['delivery-redelivery-fee'], names: [] } : null, error: null }),
  from: table => ({
   select() { return this; }, is() { return this; }, gte() { return this; }, order() { return this; },
   limit: () => Promise.resolve({ data: [{ url: 'https://www.ftc.gov/x', publisher: 'FTC', title: 'Pharmacy scams', text: 'Scammers pose as pharmacies.' }], error: null }),
   insert(row) { inserted[table].push(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: `${table}-${inserted[table].length}` }, error: null }) }), then: r => r({ data: null, error: null }) }; }
  })
 };
 const fetcher = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) { prompt = JSON.parse(init.body); return Response.json({ content: [{ type: 'text', text: `<practice>${JSON.stringify(good)}</practice>` }] }); }
  if (url.includes('/contents/content/STYLE.md')) return Response.json({ content: Buffer.from('STYLE').toString('base64') });
  if (url.endsWith('/contents/content/scam-alerts?ref=main')) return Response.json([{ name: 'weekly-2026-10-19.md' }, { name: 'weekly-2026-10-26.md' }]);
  if (url.includes('weekly-2026-10-26.md')) return Response.json({ content: Buffer.from('LATEST ALERT').toString('base64') });
  return new Response('', { status: 404 });
 };
 const result = await runGenerate({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'g' }, makeClient: () => db, fetcher, now: () => new Date('2026-10-28T10:30:00Z') });
 const asked = prompt.messages[0].content;
 assert.match(asked, /LATEST ALERT/); assert.match(asked, /Pharmacy scams/); assert.match(asked, /"opportunity_rate":0.02/); assert.match(prompt.system, /STYLE/);
 assert.deepEqual(result.queued, ['Pharmacy refill hold (email, difficulty 3)', 'Parcel call again (phone, difficulty 2)']);
 assert.equal(inserted.practice_scams[1].stable_code, 'delivery-redelivery-fee-20261028', 'an existing code gets a new one');
 assert.equal(inserted.practice_scam_versions[1].content, 'This is the parcel depot.\n\nPress 1 or say yes to pay the fee.\n\nIt goes back today.');
 assert.ok(inserted.practice_scam_versions.every(v => v.status === 'draft' && v.generated_by === 'model'));
 assert.match(result.skipped[0].issues.join(), /real brand/);
});

test('the prompt is built without the inputs leaking into the drafts', () => {
 const p = buildGeneratePrompt({ style: 'S', alert: '', leftovers: [], gaps: {}, date: '2026-10-28' });
 assert.match(p.user, /\(none this week\)/); assert.match(p.user, /say nothing about the inputs/);
});

test('the Wednesday trigger needs the job secret', async () => {
 assert.match((await startGenerateJob({ env: {} })).skipped, /ALERTS_JOB_SECRET/);
 let headers;
 assert.deepEqual(await startGenerateJob({ env: { ALERTS_JOB_SECRET: 's'.repeat(32), URL: 'https://joinsafekeep.com' }, fetcher: async (url, init) => { headers = init.headers; return new Response(null, { status: 202 }); } }), { started: true, status: 202 });
 assert.equal(headers['x-safekeep-job'], 's'.repeat(32));
});
