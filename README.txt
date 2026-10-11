Safekeep website export — October 11, 2026

Includes homepage, pricing page, styles, scripts, media, sitemap.xml and robots.txt. Both pages retain SEO metadata, canonical URLs, social tags and JSON-LD structured data.

Serve this folder from a web server root. Canonical URLs, social-image URLs, sitemap and robots point to the current Safekeep domain; update them if moving domains. Fonts load from Google Fonts.

This is a frontend export, not the full server application. /api/waitlist, /api/events, database storage and email delivery require the hosted backend and are not included. Opening the HTML locally does not enable signups.

The hosted site currently requires invited access. Search engines cannot index it until public access is enabled.

UPDATE (Oct 11, 2026): Waitlist signups now post to Formspree (form "Safekeep Waitlist", endpoint https://formspree.io/f/mbgdkpww, set in app.js as FORMSPREE_ENDPOINT), so the site works on static hosting such as GitHub Pages. Each signup emails the Formspree account owner and appears under the form's Submissions tab. /api/events page tracking is disabled. Don't upload the .claude folder.
