import { createHash } from 'node:crypto';

// Collecting the week's items: read each feed, keep items from the lookback window, fetch each page and reduce it to
// plain text. No dependencies: feeds are parsed with a small reader that handles RSS 2.0 and Atom.
const decode = s => String(s || '')
 .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
 .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
 .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]).trim() : ''; };

export function parseFeed(xml) {
 const items = [];
 for (const m of String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
  const block = m[2];
  let link = tag(block, 'link');
  if (!link) { const href = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i); link = href ? decode(href[1]) : ''; }
  const date = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
  const published = date ? new Date(date) : null;
  items.push({ title: htmlToText(tag(block, 'title')), url: link.trim(), published: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null, summary: htmlToText(tag(block, 'description') || tag(block, 'summary')) });
 }
 return items;
}

export function htmlToText(html) {
 return decode(String(html || '')
  .replace(/<(script|style|nav|header|footer|noscript|svg|form)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The main text of a page: the <main> or <article> element when there is one, otherwise the body.
export function pageText(html) {
 const main = String(html).match(/<(main|article)[\s>][\s\S]*?<\/\1>/i);
 return htmlToText(main ? main[0] : html).slice(0, 60000);
}

export const contentHash = text => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

export async function collect({ config, fetcher = globalThis.fetch, now = new Date() }) {
 const since = now.getTime() - (config.lookback_days || 8) * 86400000;
 const results = [], errors = [];
 const get = async url => {
  const response = await fetcher(url, { headers: { 'User-Agent': 'SafekeepAlertsBot/1.0 (+https://joinsafekeep.com/scam-alerts/)', Accept: 'text/html,application/xml,application/rss+xml,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.text();
 };
 for (const feed of config.feeds) {
  let items;
  try { items = parseFeed(await get(feed.url)); } catch (e) { errors.push(`${feed.publisher}: feed ${e.message}`); continue; }
  items = items.filter(i => /^https:\/\//.test(i.url) && (!i.published || new Date(i.published).getTime() >= since)).slice(0, config.max_items_per_feed || 12);
  for (const item of items) {
   let text = '';
   // News search results link through a redirect page; their summaries are enough to judge them as leads.
   if (feed.kind !== 'news') { try { text = pageText(await get(item.url)); } catch (e) { errors.push(`${feed.publisher}: ${item.url} ${e.message}`); } }
   text = text || item.summary || item.title;
   if (text.length < 40) continue;
   results.push({ publisher: feed.publisher, kind: feed.kind, title: item.title.slice(0, 500), url: item.url, published_at: item.published, text, content_hash: contentHash(text) });
  }
 }
 return { items: results, errors };
}
