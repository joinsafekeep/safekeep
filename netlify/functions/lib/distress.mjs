// Reading a reply to a practice text for fear or confusion (PRD: Safety rules > Distress handling). Conservative by
// design: a false alarm costs a kind message and a check-in; a miss leaves someone frightened. So obvious words decide
// on their own, the expected replies for the scenario ("YES", an amount) decide the other way, and everything in
// between goes to a small Claude call that is told to answer DISTRESS when unsure. If the call fails, it's DISTRESS.
const WORRIED = /\b(scared|afraid|frighten|terrified|worried|anxious|panic|crying|upset|confused|don'?t understand|who (is|are) (this|you)|what is (this|going on)|is this real|is this a scam|am i in trouble|leave me alone|stop (texting|messaging|contacting|this)|please stop|police|help me|my (bank|card) (was|is) (hacked|stolen)|i'?m (old|alone|sick)|threat)/i;

export function quickRead(text, replyKeywords = []) {
 const t = String(text || '').trim();
 if (WORRIED.test(t)) return 'distress';
 const words = (replyKeywords || []).map(k => String(k).toLowerCase());
 const lower = t.toLowerCase();
 if (words.some(k => k && (lower === k || lower.startsWith(k + ' ') || lower.startsWith(k + '.') || lower.startsWith(k + '!')))) return 'ok';
 if (/^\$?\d[\d,.]*$/.test(t)) return 'ok';
 return null;
}

export async function classifyReply({ text, replyKeywords, apiKey, model = 'claude-haiku-5-5', fetcher = globalThis.fetch }) {
 const quick = quickRead(text, replyKeywords);
 if (quick) return quick;
 if (!apiKey) return 'distress';
 try {
  const response = await fetcher('https://api.anthropic.com/v1/messages', {
   method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
   body: JSON.stringify({ model, max_tokens: 5, system: 'An older adult received a practice scam text from a scam-awareness service they signed up for, and replied. Decide whether the reply shows fear, distress, confusion about who is texting, or a wish to stop (DISTRESS), or reads as ordinary engagement with the message, such as agreeing, asking for details, or sending information (OK). When unsure, answer DISTRESS. Answer with one word: DISTRESS or OK.', messages: [{ role: 'user', content: `Reply: """${String(text).slice(0, 600)}"""` }] }),
   signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return 'distress';
  const data = await response.json();
  const answer = (data.content || []).map(b => b.text || '').join('').trim().toUpperCase();
  return answer.startsWith('OK') ? 'ok' : 'distress';
 } catch { return 'distress'; }
}
