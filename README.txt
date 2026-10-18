Safekeep website export — October 11, 2026

Includes homepage, pricing page, styles, scripts, media, sitemap.xml and robots.txt. Both pages retain SEO metadata, canonical URLs, social tags and JSON-LD structured data.

Serve this folder from a web server root. Canonical URLs, social-image URLs, sitemap and robots point to the current Safekeep domain; update them if moving domains. Fonts load from Google Fonts.

This is a frontend export, not the full server application. /api/waitlist, /api/events, database storage and email delivery require the hosted backend and are not included. Opening the HTML locally does not enable signups.

The hosted site currently requires invited access. Search engines cannot index it until public access is enabled.

UPDATE (Oct 11, 2026): Waitlist signups now post to Formspree (form "Safekeep Waitlist", endpoint https://formspree.io/f/mbgdkpww, set in app.js as FORMSPREE_ENDPOINT), so the site works on static hosting such as GitHub Pages. Each signup emails the Formspree account owner and appears under the form's Submissions tab. /api/events page tracking is disabled. Don't upload the .claude folder.

SCAM ALERTS (added Oct 18, 2026)
Articles live as markdown in content/scam-alerts/<slug>.md and publish at https://joinsafekeep.com/scam-alerts/<slug>. After adding or editing one, run:

  python3 scripts/og-images.py      # share image for any new article (needs Playwright)
  node scripts/build-scam-alerts.mjs

Before writing, read content/STYLE.md (house voice and phrases to avoid). content/KEYWORDS.md lists the search terms each guide targets and topics worth covering next.

That regenerates scam-alerts/*.html (the index and every article), sitemap.xml and llms.txt. Commit the generated files along with the markdown; Netlify serves them as-is, no build step. Styles for the section are in scam-alerts.css. The header, footer and waitlist dialog are copied from pricing.html on each build, so change those there.

Front matter: title, seo_title (<= 60 chars), description (150-155 chars), summary (index card), keywords, type ("Guide", "Seasonal alert", or "Weekly alert" for the weekly posts), order (optional sort among same-date guides), published and updated (YYYY-MM-DD), draft: true to hold a file back. Under "## Frequently asked questions", each "### Question" heading plus the paragraph after it becomes FAQ schema. Link to [Join the free waitlist](#waitlist) to open the signup dialog.
