# Account onboarding — deployment and operations

This change adds /account/ and a Netlify Function at /api/account. The marketing site and Formspree waitlist stay independent. Authentication uses Supabase Auth with PKCE and server-managed HttpOnly, Secure, SameSite=Lax cookies. The browser never receives tokens in JSON or local storage. All account mutations require a matching Origin and JSON content type. Authenticated requests validate the user with Supabase Auth and execute database operations as that user; no service-role key is needed.

## Implemented

- Adult signup, email verification, resend, login, logout, password recovery and password change with current-password verification. Reset/change signs out all Supabase refresh sessions; existing access tokens may remain valid until expiry.
- Profiles: names, optional adult DOB, IANA timezone, adult attestation.
- Verified login email is synchronized from auth.users, not submitted claims or user metadata.
- Multiple labeled cell/home/office/other phone contacts with optional extension, E.164 validation and an explicit unverified state.
- Explicit email-practice opt-in and withdrawal, append-only consent history, quiet hours, frequency, pause. Email must match the current confirmed login address. No phone consent or sending is enabled yet. Queued practices are cancelled on withdrawal/pause; a future sender must also check current consent immediately before sending.
- Database ownership checks, strict grants and a private privileged helper with explicit auth checks. End users cannot self-verify contacts or forge consent timestamps/policy versions.

## Sign-up handoff (added October 29, 2026)

The marketing dialog no longer ends at a Stripe Payment Link. After the plan step it creates the account (password, adult attestation, Terms of Service and Privacy Policy), verifies the email with the six-digit code from the verification email (the link still works in the same browser), then sends the person to /account/ for the profile and checkout. Built to the "Sign-up" section of the MVP PRD.

- New /api/account actions: `verify_code` (email + code → session), `intent` (save a plan choice), `checkout` (returns the Stripe URL for the chosen plan with `client_reference_id` = user id and `prefilled_email`; an interim stand-in for /api/billing/checkout, same `{url}` response), `accept_policies` (re-acceptance after a version bump). `signup` now requires `terms_accepted: true` and accepts `first_name` and an `intent` object (`plan`, `billing`, `help_for`, `invitee_name`, `invitee_email`, `invitee_phone`, `lead_session_id`), validated and stored as user metadata (`safekeep_intent`, `safekeep_signup`). `state` returns `intent`, `signup`, `acceptances`, `policy_version` and `plans`.
- Terms acceptance is recorded in `policy_acceptances` (database/signup-terms.sql) the first time a verified session exists, from the timestamp, version, hashed IP and user agent captured at sign-up. `POLICY_VERSION` in account.mjs is the version string; bump it when /terms/ or /privacy/ change and the account page re-prompts.
- The adult attestation given at sign-up carries over to the profile form, so it is not asked twice.
- Metadata is still untrusted for identity. The intent only decides which plan is offered and prefills the first invite. For the acceptance record, metadata decides only whether the box was ticked at sign-up and when (bounded to the last 90 days by the RPC); the version written is the server's `POLICY_VERSION`, and `checkout` refuses until both documents are accepted at that version.
- Turnstile covers both account-creation forms: the dialog (site key on the dialog element) and the standalone form on /account/ (site key on `#signup-form`; the /account/* CSP allows challenges.cloudflare.com). The same `TURNSTILE_SECRET_KEY` enforces both.

Before deploying:

1. Apply database/signup-terms.sql to the Supabase project (table, RLS, replaced `account_action`). The function fails on `state` until it is applied.
2. In Supabase Auth email templates, add the code to the confirmation template alongside the link, for example `Your Safekeep code is {{ .Token }}` above `{{ .ConfirmationURL }}`. The dialog asks for the code; the link keeps working in the same browser.
3. In the Stripe dashboard, change each Payment Link's "After payment" redirect to `https://joinsafekeep.com/account/?checkout=success`. Until then `/?signup=complete` forwards there.
4. Optional, before public enrollment: Cloudflare Turnstile on the account-creation step. Set `TURNSTILE_SECRET_KEY` in the Functions environment and the site key in `data-turnstile-site-key` on the dialog in index.html and pricing.html (then rebuild scam-alerts). The contact step is untouched so the ads conversion is unaffected.
5. Optional: `POLICY_IP_SALT` for the IP hash on acceptance records (defaults to the app origin).
6. Funnel events: the dialog sends `signup_page_view`, `signup_form_open`, `signup_contact`, `signup_plan`, `signup_account_created` and `signup_verified` to the Google tag; create reports or conversions for them. /account/ loads no Google tag (its CSP allows only same-origin scripts), so `checkout_started`, `paid` and `first_seat` wait for the billing webhook, which can report them server-side.
7. Review Supabase Auth rate limits (sign-ups, OTP verifications, resends per hour) in the dashboard before public enrollment; `verify_code` passes Supabase's 429 through as "Please wait before trying again."
8. Still to build from the PRD: the 24h/72h "verified but never paid" reminders, the weekly cleanup of unconfirmed users older than 30 days, clearing the intent once billing has used it, and the subscription record that lets the page know a payment landed. Until then /account/ keeps "Continue to payment" available after a return from Stripe, and practice consent is hidden client-side before that return (server-side enforcement comes with the subscriptions table).

## Settings (added October 29, 2026)

Built to the "Settings" section of the MVP PRD, on top of the sign-up handoff. Migration: database/settings.sql (tests: database/settings-tests.sql, run in a transaction; both verified on a local Postgres 16 with a stand-in auth schema).

- Channels: email, text and phone are separate consents in consent_events (policy version `practice-consent-2026-10-29`). Text needs a verified cell (`kind = mobile`); phone needs any verified, unsuppressed number; email still has to match the verified login address. One number per channel is live at a time (the page withdraws the old grant before granting a new one). Turning practices on needs at least one current grant on a verified contact, on any channel.
- Phone verification: `phone_verify_start` / `phone_verify_check` call Twilio Verify (a text to a cell, an automated call that reads the code to a landline). The code is checked server-side; the database is told through `verify_phone` with an HMAC proof under `PHONE_VERIFY_SECRET`, which the RPC recomputes from `safekeep_private.secrets`. A signed-in user calling the RPC directly cannot produce the proof. `user_contacts.verification_method` records how (`otp_sms`, `otp_call`, `auth_email`, `invite_token`).
- Removing a number (`remove_phone`) keeps the row for consent history, suppresses it (`suppressed_at`, `suppression_reason = removed_by_user`), withdraws its grants and cancels its queue. The scheduler must skip suppressed contacts.
- Preferences: per-channel monthly caps (`email_cap_per_month`, `text_cap_per_month`, `call_cap_per_month`, 0–7, defaults 4/4/2), `paused_until` (a date within the next year; queued practices before it are cancelled and the scheduler resumes on its own), `alerts_opt_in`. The seven-a-month hard cap across channels and the never-two-in-a-day rule are the scheduler's to enforce.
- Family: `report_recipients` (up to five active per participant, add/remove, `unsubscribe_token_hash` filled by the report job). Who sponsors whom waits for subscription_members; the page shows a placeholder line.
- Deletion and export: `request_deletion` withdraws every grant, turns practice off, cancels the queue, removes report recipients, records the request in `account_deletions` and signs the person out everywhere; signing in within 30 days shows a banner with `cancel_deletion`. `export` returns one JSON file of everything the account holds, downloaded while signed in (a mailed copy waits for the transactional email provider). The hard delete is `netlify/functions/scheduled-cleanup.mjs`, daily, which also removes unconfirmed sign-ups older than 30 days.

Before deploying:

1. Apply database/settings.sql, then `insert into safekeep_private.secrets values ('phone_verify_proof','<value>')` with the same value as `PHONE_VERIFY_SECRET` in the Functions environment. Until both are set, verification replies "Phone verification isn’t available yet."
2. Twilio Verify: create a Verify service, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`. Verify's own texts and calls are not A2P practice traffic, but confirm with Twilio that the service is approved for the call channel before landlines are offered.
3. Set `SUPABASE_SERVICE_ROLE_KEY` for the scheduled cleanup function only (Netlify lets a variable be scoped to functions; keep it out of any request-path function and out of client code). The job skips with a note until it is set.
4. The account page offers channel consent only after a return from Stripe or once any consent exists (page-level guard, as in the sign-up handoff); the server-side gate arrives with the subscriptions table.

## Supabase state

Project: iybcbztvofqihvqhqfoo. Migration account_onboarding_and_consent was applied to the hosted project. database/account-onboarding.sql is the exact SQL record, not an unapplied migration to rerun there. The preceding foundation was created in migration safekeep_account_practice_foundation. database/base-schema.sql records that original migration for review and reproducibility on a clean database. Apply base-schema.sql, account-onboarding.sql, signup-terms.sql, then settings.sql once when provisioning a separate environment.

Email auth is enabled, email auto-confirmation is disabled, anonymous users and phone login are disabled (verified through public Auth settings). Never turn on auto-confirmation as a delivery workaround.

## Required before real-user launch

1. In Netlify, review and deploy the GitHub branch. netlify.toml builds only public assets into dist; server code, SQL, tests, dependencies and docs are not published as static files. Use Node 22.
2. Configure APP_ORIGIN in Netlify's Functions environment to the exact canonical origin (e.g. https://joinsafekeep.com), with no trailing slash. Optional overrides are SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY; current project publishable defaults are built in and are not secrets. Do not configure a service-role key. Production cookies are always Secure. Local development can use APP_ORIGIN=http://localhost:8888 and COOKIE_SECURE=false. Preview deployments need their own exact origin and redirect allowlist entry; don't set a production APP_ORIGIN in a preview.
3. In Supabase Auth URL Configuration, set the site URL and allow the exact redirects https://joinsafekeep.com/account/ and https://joinsafekeep.com/account/?flow=recovery (replace origin for an approved preview). Use standard confirmation/reset templates containing .ConfirmationURL so PKCE codes return to this handler. Verification/reset links must be opened in the same browser where requested. Request a new email if the browser changes or a newer request replaced the verifier cookie. GET merely displays the confirmation form; POST consumes the code. No automatic code exchange by a link scanner.
4. Configure production SMTP and a verified sender domain. Supabase's default email service is restricted and not appropriate for public onboarding. An existing Twilio account can supply SMS later; email needs its own configured sender (e.g. SendGrid SMTP if already available). Do not paste provider credentials into chat, GitHub, or public environment variables.
5. Set the Supabase password policy to at least 12 characters (the application also enforces 12–128), enable leaked-password protection where available, review Auth rate limits, and add bot protection before public enrollment. Configure equivalent edge/IP controls on the account function; server-to-server Auth calls can share network rate limits. Avoid request-body logging and analytics on /account/.
6. Run a real mailbox acceptance test on the deployment: signup → email verification → profile → add phone → consent → preferences → sign out → sign in → reset email → set password → old password rejected → new password accepted. Check code replay and expiry, resend behavior, two-account isolation, mobile form layout and error messaging. Do not mark these passed from mocked endpoint tests.

MFA enrollment, self-service email editing, caregivers, live messaging and billing are not built. Do not advertise these as implemented. Production personal-data collection should wait for retention/deletion handling and the launch checks above.

## Verification performed

- npm test: endpoint tests for origin/CSRF checks, verified-user gating, safe JSON responses, password reauthentication, recovery type checks and global logout.
- npm run check: server and browser JavaScript parse checks.
- node scripts/publish-site.mjs: static build.
- database/account-access-tests.sql: executed against Supabase in a transaction, testing profile ownership, verified email, unverified phone, no consent bypass, explicit opt-in/withdrawal, user-ID spoof rejection, cross-user access and unverified/anonymous denial. Synthetic fixtures rolled back.
- Supabase security advisor: informational notices for intentionally server-only tables with no client policies; no new warning/error findings. Unused-index notices are expected for an empty project.

The initial schema/access tests in earlier local artifacts predate the new RPC-only write model; use account-access-tests.sql for current writes.
