Safekeep website export — October 11, 2026

Includes homepage, pricing page, styles, scripts, media, sitemap.xml and robots.txt. Both pages retain SEO metadata, canonical URLs, social tags and JSON-LD structured data.

Serve this folder from a web server root. Canonical URLs, social-image URLs, sitemap and robots point to the current Safekeep domain; update them if moving domains. Fonts load from Google Fonts.

This is a frontend export, not the full server application. /api/waitlist, /api/events, database storage and email delivery require the hosted backend and are not included. Opening the HTML locally does not enable signups.

The hosted site currently requires invited access. Search engines cannot index it until public access is enabled.

UPDATE (Oct 11, 2026): Signups post to Formspree (form "Safekeep Waitlist", endpoint https://formspree.io/f/mbgdkpww, set in app.js as FORMSPREE_ENDPOINT), so the site works on static hosting such as GitHub Pages. Each signup emails the Formspree account owner and appears under the form's Submissions tab. /api/events page tracking is disabled. Don't upload the .claude folder.

UPDATE (Oct 25, 2026): The waitlist is now a sign-up flow. After contact details (and the optional who-is-it-for steps), people choose a plan and billing period and are sent to a Stripe Payment Link. The six live links (products "Safekeep Individual", "Safekeep Pairs", "Safekeep Family") are set in STRIPE_LINKS in app.js, and each redirects to https://joinsafekeep.com/?signup=complete after payment. Subscribers manage or cancel their plan in the Stripe customer portal (https://billing.stripe.com/p/login/5kQ3cx5Mf4tk11Z7lt8Vi00), linked as "Manage subscription" in the footer; it returns them to https://joinsafekeep.com/. The session id is passed as client_reference_id, so Stripe payments can be matched to Formspree submissions. Until a link is filled in, choosing that plan saves the choice to Formspree and tells the person we'll email a payment link.

UPDATE (Oct 29, 2026): The plan step no longer sends people to a Payment Link. The dialog now creates the account (password, 18+, terms), verifies the email with the 6-digit code from the verification email, and continues on /account/ with the profile and then payment. The Payment Links moved to netlify/functions/account.mjs (checkout action) and are opened with client_reference_id set to the account's user id, so payments match accounts. /terms/ and /privacy/ are the documents the checkbox links to. Deployment steps are in docs/accounts.md under "Sign-up handoff".

UPDATE (Oct 29, 2026, later): /account/ now has the Settings section of the MVP PRD: per-channel practice consent (email, text, phone), phone verification by code (Twilio Verify, once configured), per-channel monthly caps, pause until a date, the weekly-alert opt-in, report recipients, data export and self-service deletion with a 30-day grace period. Deployment steps are in docs/accounts.md under "Settings".

UPDATE (Oct 29, 2026, cancellation): Stripe now tells Safekeep about subscriptions through a webhook (/api/billing/webhook), so /account/ shows the plan, its next payment or end date, seats in use, and a Manage subscription button that opens the Stripe Billing Portal for the right customer. When a plan ends, every seat stops, queued practice is cancelled, and sponsor and participants each get one plain email. A participant can leave a plan from their account. Deployment steps are in docs/accounts.md under "Cancellation".

SCAM ALERTS (added Oct 18, 2026)
Articles live as markdown in content/scam-alerts/<slug>.md and publish at https://joinsafekeep.com/scam-alerts/<slug>. After adding or editing one, run:

  python3 scripts/og-images.py      # share image for any new article (needs Playwright)
  node scripts/build-scam-alerts.mjs

Before writing, read content/STYLE.md (house voice and phrases to avoid). content/KEYWORDS.md lists the search terms each guide targets and topics worth covering next.

That regenerates scam-alerts/*.html (the index and every article), sitemap.xml and llms.txt. Commit the generated files along with the markdown; Netlify serves them as-is, no build step. Styles for the section are in scam-alerts.css. The header, footer and sign-up dialog are copied from pricing.html on each build, so change those there.

Front matter: title, seo_title (<= 60 chars), description (150-155 chars), summary (index card), keywords, type ("Guide", "Seasonal alert", or "Weekly alert" for the weekly posts), order (optional sort among same-date guides), published and updated (YYYY-MM-DD), draft: true to hold a file back. Under "## Frequently asked questions", each "### Question" heading plus the paragraph after it becomes FAQ schema. Link to [Sign up](#waitlist) to open the sign-up dialog.
