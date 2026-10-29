#!/usr/bin/env node
// Builds the Scam Alerts section from content/scam-alerts/*.md.
//
//   node scripts/build-scam-alerts.mjs
//
// Run scripts/og-images.py first to make share images for new articles.
//
// Writes:
//   scam-alerts/index.html        -> https://joinsafekeep.com/scam-alerts/
//   scam-alerts/<slug>.html       -> https://joinsafekeep.com/scam-alerts/<slug>
//   sitemap.xml, llms.txt
//
// The page chrome (Google tag, header, footer, sign-up dialog, scripts) is
// copied from pricing.html, so nav or footer changes there carry over the next
// time this runs. No dependencies; Node 18+.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://joinsafekeep.com';
const SECTION = '/scam-alerts';
const CONTENT_DIR = join(ROOT, 'content', 'scam-alerts');
const OUT_DIR = join(ROOT, 'scam-alerts');
const SHARE_IMAGE = `${SITE}/hero-video-poster.jpg`;
const SHARE_IMAGE_ALT = 'An older adult using her smartphone at home';
// Hand-made pages that belong in the sitemap alongside the generated ones.
const STATIC_PAGES = [
  { path: '/', file: 'index.html' },
  { path: '/pricing', file: 'pricing.html' },
  { path: '/terms/', file: 'terms/index.html' },
  { path: '/privacy/', file: 'privacy/index.html' },
];

// ---------------------------------------------------------------- utilities

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Curly quotes and apostrophes for display text. \u0001 marks the start of bold
// text, which counts as an opening position.
function smartQuotes(s) {
  return s
    .replace(/(^|[\s(\[\u0001\u2014\u2013/-])"/g, '$1\u201c')
    .replace(/"/g, '\u201d')
    .replace(/(^|[\s(\[\u0001\u2014\u2013/-])'/g, '$1\u2018')
    .replace(/'/g, '\u2019');
}

// ----------------------------------------------------------------- markdown
// A small renderer for the subset these articles use: ## and ### headings,
// paragraphs, bullet and numbered lists, pipe tables, **bold** and [links](url).

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += plain(text.slice(last, m.index));
    out += link(m[1], m[2]);
    last = m.index + m[0].length;
  }
  return out + plain(text.slice(last));
}

function plain(text) {
  const marked = text.replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0002');
  return smartQuotes(esc(marked)).replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>');
}

function link(label, href) {
  const text = inline(label);
  const isWaitlist = href === '#waitlist' || (/^https:\/\/joinsafekeep\.com\/?$/.test(href) && /waitlist|sign up/i.test(label));
  if (isWaitlist) return `<button class="text-link" type="button" data-open-waitlist>${text} <span aria-hidden="true">→</span></button>`;
  if (href.startsWith('https://joinsafekeep.com')) href = href.slice('https://joinsafekeep.com'.length) || '/';
  if (/^https?:\/\//.test(href)) return `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  return `<a href="${attr(href)}">${text}</a>`;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{2,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const html = inline(heading[2].trim());
      blocks.push({ type: `h${level}`, html, id: slugify(heading[2]) });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const listType = /^\s*[-*]\s+/.test(line) ? 'ul' : /^\s*\d+\.\s+/.test(line) ? 'ol' : null;
    if (listType) {
      const marker = listType === 'ul' ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      blocks.push({ type: listType, items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{2,3}\s/.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++].trim());
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

function blocksToHtml(blocks) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'h2': return `<h2 id="${b.id}">${b.html}</h2>`;
      case 'h3': return `<h3 id="${b.id}">${b.html}</h3>`;
      case 'ul': case 'ol': return `<${b.type}>${b.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${b.type}>`;
      case 'table': return `<div class="table-scroll"><table><thead><tr>${b.head.map((h) => `<th scope="col">${inline(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'p': {
        const html = inline(b.text);
        if (b.text.startsWith('**Quick answer:**')) return `<p class="quick-answer">${html}</p>`;
        if (html.includes('data-open-waitlist')) return `<p class="inline-cta">${html}</p>`;
        return `<p>${html}</p>`;
      }
      case 'raw': return b.html;
      default: return '';
    }
  }).join('\n');
}

// --------------------------------------------------------------- articles

function parseArticle(file) {
  const raw = readFileSync(join(CONTENT_DIR, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) && !v.slice(1, -1).includes('"')) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  for (const key of ['title', 'description', 'published']) if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
  const slug = meta.slug || file.replace(/\.md$/, '');
  const blocks = renderMarkdown(m[2]);

  // FAQ = every ### heading under "## Frequently asked questions", with the text that follows it.
  const faq = [];
  let inFaq = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'h2') inFaq = /frequently asked questions/i.test(stripTags(b.html));
    else if (inFaq && b.type === 'h3') {
      const answer = [];
      for (let j = i + 1; j < blocks.length && !/^h[23]$/.test(blocks[j].type); j++) answer.push(stripTags(blocksToHtml([blocks[j]])));
      faq.push({ q: stripTags(b.html), a: answer.join(' ') });
    }
  }

  const words = m[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').split(/\s+/).filter(Boolean).length;
  return {
    ...meta,
    slug,
    url: `${SITE}${SECTION}/${slug}`,
    path: `${SECTION}/${slug}`,
    updated: meta.updated || meta.published,
    order: Number(meta.order || 99),
    type: meta.type || 'Guide',
    weekly: /weekly/i.test(meta.type || ''),
    draft: /^(true|yes)$/i.test(meta.draft || ''),
    minutes: Math.max(1, Math.round(words / 220)),
    // Share image from scripts/og-images.py, or the homepage photo if there isn't one yet.
    image: existsSync(join(ROOT, 'og', `${slug}.png`)) ? `${SITE}/og/${slug}.png` : SHARE_IMAGE,
    bodyHtml: blocksToHtml(blocks),
    faq,
  };
}

// ------------------------------------------------------------------ chrome

const pricing = readFileSync(join(ROOT, 'pricing.html'), 'utf8');
const gtag = (pricing.match(/<!-- Google tag[\s\S]*?<\/script><script>[\s\S]*?<\/script>/) || [''])[0];
const bodyTag = '<body data-audience="self">';
const chromeTop = pricing.slice(pricing.indexOf('<a class="skip"'), pricing.indexOf('<main')).replace(/ aria-current="page"/g, '');
const chromeBottom = pricing.slice(pricing.indexOf('</main>') + '</main>'.length).replace(/ aria-current="page"/g, '');
if (!chromeTop.includes('<header') || !chromeBottom.includes('/app.js')) throw new Error('Could not read the header/footer from pricing.html');
const markCurrent = (html) => html.replace(/<a href="\/scam-alerts\/">/g, '<a href="/scam-alerts/" aria-current="page">');

function page({ title, description, canonical, ogType = 'website', image = SHARE_IMAGE, imageAlt = SHARE_IMAGE_ALT, ld, body }) {
  return `<!doctype html>
<html lang="en"><head>${gtag}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${attr(description)}"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/scam-alerts.css"><link rel="canonical" href="${attr(canonical)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta property="og:type" content="${ogType}"><meta property="og:site_name" content="Safekeep"><meta property="og:title" content="${attr(title)}"><meta property="og:description" content="${attr(description)}"><meta property="og:url" content="${attr(canonical)}"><meta property="og:image" content="${image}"><meta property="og:image:alt" content="${attr(imageAlt)}">${image === SHARE_IMAGE ? '' : '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${attr(title)}"><meta name="twitter:description" content="${attr(description)}"><meta name="twitter:image" content="${image}"><link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable site summary">${ld.map(jsonLd).join('')}</head>${bodyTag}
${markCurrent(chromeTop)}${body}${markCurrent(chromeBottom)}`;
}

const ORG = { '@type': 'Organization', name: 'Safekeep', url: `${SITE}/`, logo: { '@type': 'ImageObject', url: `${SITE}/apple-touch-icon.png` } };

const waitlistCallout = `<section class="waitlist-section"><div class="wrap waitlist-callout"><h2>A little practice.<br>A little more prepared.</h2><p>Help yourself or someone you love stay ready.</p><button class="button" type="button" data-open-waitlist>Sign up <span aria-hidden="true">→</span></button><p class="cta-reassurance">Plans from $5/month. 60-day money-back guarantee.</p></div></section>`;

function card(a) {
  return `<li class="alert-card"><h3><a href="${a.path}">${smartQuotes(esc(a.title))}</a></h3><p>${smartQuotes(esc(a.summary || a.description))}</p><p class="alert-card-meta">${a.weekly ? longDate(a.published) : `Updated ${longDate(a.updated)}`} · ${a.minutes} min read</p></li>`;
}

function articlePage(a, all) {
  const related = all.filter((x) => x.slug !== a.slug && !x.weekly).slice(0, 3);
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: a.title,
      description: a.description,
      datePublished: a.published,
      dateModified: a.updated,
      inLanguage: 'en-US',
      image: a.image,
      keywords: a.keywords || undefined,
      author: { '@type': 'Organization', name: 'The Safekeep team', url: `${SITE}/#about` },
      publisher: ORG,
      mainEntityOfPage: a.url,
      isPartOf: { '@type': 'CollectionPage', name: 'Safekeep Scam Alerts', url: `${SITE}${SECTION}/` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Scam alerts', item: `${SITE}${SECTION}/` },
        { '@type': 'ListItem', position: 3, name: a.title, item: a.url },
      ],
    },
  ];
  if (a.faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: a.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });

  const body = `<main id="main" class="scam-alerts-page">
<nav class="breadcrumbs wrap" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/scam-alerts/">Scam alerts</a></li><li aria-current="page">${smartQuotes(esc(a.title))}</li></ol></nav>
<article class="article wrap">
<header class="article-header hero-copy"><h1>${smartQuotes(esc(a.title))}</h1><p class="article-meta">By the Safekeep team · <time datetime="${a.updated}">Updated ${longDate(a.updated)}</time> · ${a.minutes} min read</p></header>
<div class="article-body">
${a.bodyHtml}
</div>
<aside class="article-help"><p><strong>Worried about something that just happened?</strong> You don’t have to figure it out alone.</p><button class="outline" type="button" data-help>See what to do next <span aria-hidden="true">→</span></button></aside>
<p class="article-disclaimer">Safekeep publishes scam-awareness education, not legal or financial advice. Details change quickly; check the linked sources for the latest guidance.</p>
</article>
${related.length ? `<section class="related wrap" aria-labelledby="related-title"><h2 id="related-title">More scam alerts</h2><ul class="alert-grid">${related.map(card).join('')}</ul><p><a href="/scam-alerts/">See all scam alerts →</a></p></section>` : ''}
${waitlistCallout}
</main>`;
  return page({ title: a.seo_title || `${a.title} | Safekeep`, description: a.description, canonical: a.url, ogType: 'article', image: a.image, imageAlt: a.image === SHARE_IMAGE ? SHARE_IMAGE_ALT : a.title, ld, body });
}

function indexPage(all) {
  const weekly = all.filter((a) => a.weekly);
  const guides = all.filter((a) => !a.weekly);
  const title = 'Scam Alerts for Older Adults & Families | Safekeep';
  const description = 'Plain-language guides to the scams targeting older adults right now, from AI voice-cloning calls to Medicare and bank impostors, plus what to do if it happens.';
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Safekeep Scam Alerts',
      description,
      url: `${SITE}${SECTION}/`,
      publisher: ORG,
      mainEntity: { '@type': 'ItemList', itemListElement: all.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: a.url, name: a.title })) },
    },
  ];
  const body = `<main id="main" class="scam-alerts-page">
<section class="alerts-intro wrap hero-copy"><h1>Scams going around right now, <em>explained.</em></h1><p>What’s being aimed at older adults lately, how to recognize it, and what to do if something has already happened. We add a new alert every week.</p></section>
${weekly.length ? `<section class="wrap alerts-list" aria-labelledby="weekly-title"><h2 id="weekly-title">This week’s alerts</h2><ul class="alert-grid">${weekly.slice(0, 6).map(card).join('')}</ul></section>` : ''}
<section class="wrap alerts-list" aria-labelledby="guides-title"><h2 id="guides-title">Guides</h2><ul class="alert-grid">${guides.map(card).join('')}</ul></section>
${weekly.length > 6 ? `<section class="wrap alerts-list" aria-labelledby="archive-title"><h2 id="archive-title">Past weekly alerts</h2><ul class="alert-archive">${weekly.slice(6).map((a) => `<li><a href="${a.path}">${smartQuotes(esc(a.title))}</a> <span>${longDate(a.published)}</span></li>`).join('')}</ul></section>` : ''}
<section class="wrap"><div class="help-banner"><div><h3>Worried about something that just happened?</h3><p>You don’t have to figure it out alone.</p></div><button class="outline" type="button" data-help>See what to do next <span aria-hidden="true">→</span></button></div></section>
${waitlistCallout}
</main>`;
  return page({ title, description, canonical: `${SITE}${SECTION}/`, ld, body });
}

// ------------------------------------------------------------------- build

const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md')).sort();
const articles = files.map(parseArticle).filter((a) => !a.draft)
  .sort((a, b) => (b.weekly - a.weekly) || b.published.localeCompare(a.published) || a.order - b.order);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
for (const a of articles) writeFileSync(join(OUT_DIR, `${a.slug}.html`), articlePage(a, articles));
writeFileSync(join(OUT_DIR, 'index.html'), indexPage(articles));

// sitemap.xml: the hand-made pages keep their existing lastmod dates.
const oldSitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
const lastmodFor = (path) => (oldSitemap.match(new RegExp(`<loc>${SITE.replace(/\./g, '\\.')}${path.replace(/\//g, '\\/')}</loc><lastmod>([^<]+)</lastmod>`)) || [])[1];
const newest = articles.reduce((d, a) => (a.updated > d ? a.updated : d), '');
const urls = [
  ...STATIC_PAGES.map((p) => ({ loc: `${SITE}${p.path}`, lastmod: lastmodFor(p.path) })),
  { loc: `${SITE}${SECTION}/`, lastmod: newest },
  ...articles.map((a) => ({ loc: a.url, lastmod: a.updated })),
];
writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);

// llms.txt: a plain summary for AI answer engines (https://llmstxt.org).
writeFileSync(join(ROOT, 'llms.txt'), `# Safekeep

> Safekeep is a monthly subscription that helps older adults recognize scams through weekly simulated scam texts, emails, and phone calls, with plain-language feedback after each one and a monthly progress report shared with family members they choose. It is scam-awareness education and does not access bank accounts. Plans start at $5/month, with a 60-day money-back guarantee.

## Product

- [Home](${SITE}/): how the weekly simulations and monthly family reports work
- [Pricing](${SITE}/pricing): Individual, Pairs, and Family plans

## Scam alerts

${articles.map((a) => `- [${a.title}](${a.url}): ${a.description}`).join('\n')}

## If you think you've been scammed (U.S.)

- Call your bank using the number on your card, report at https://www.ic3.gov/ and https://reportfraud.ftc.gov/, and call the National Elder Fraud Hotline at 1-833-372-8311.
`);

console.log(`Built ${articles.length} articles, the index, sitemap.xml and llms.txt.`);
