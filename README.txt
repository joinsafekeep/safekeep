Safekeep website export — October 11, 2026

Includes homepage, pricing page, styles, scripts, media, sitemap.xml and robots.txt. Both pages retain SEO metadata, canonical URLs, social tags and JSON-LD structured data.

Serve this folder from a web server root. Canonical URLs, social-image URLs, sitemap and robots point to the current Safekeep domain; update them if moving domains. Fonts load from Google Fonts.

This is a frontend export, not the full server application. /api/waitlist, /api/events, database storage and email delivery require the hosted backend and are not included. Opening the HTML locally does not enable signups.

The hosted site currently requires invited access. Search engines cannot index it until public access is enabled.

UPDATE (Oct 11, 2026): Signups post to Formspree (form "Safekeep Waitlist", endpoint https://formspree.io/f/mbgdkpww, set in app.js as FORMSPREE_ENDPOINT), so the site works on static hosting such as GitHub Pages. Each signup emails the Formspree account owner and appears under the form's Submissions tab. /api/events page tracking is disabled. Don't upload the .claude folder.

UPDATE (Oct 25, 2026): The waitlist is now a sign-up flow. After contact details (and the optional who-is-it-for steps), people choose a plan and billing period and are sent to a Stripe Payment Link. The six live links (products "Safekeep Individual", "Safekeep Pairs", "Safekeep Family") are set in STRIPE_LINKS in app.js, and each redirects to https://joinsafekeep.com/?signup=complete after payment. The session id is passed as client_reference_id, so Stripe payments can be matched to Formspree submissions. Until a link is filled in, choosing that plan saves the choice to Formspree and tells the person we'll email a payment link.
