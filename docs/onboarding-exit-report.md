# Onboarding programme — exit report

**Date:** 2026-11-07 · **Plan:** `docs/onboarding-plan.md` · **Slices:** ON1–ON6 · **Branch:** `Dev`

## What was built

Self-serve sign-up (with email verification), a **Controller subscription through Stripe required to use the app**, an organisation that starts locked until it has paid,
a seven-step set-up wizard, seats and packages, team invitations (single and bulk, expiry, resend, revoke, seat reserved on invite), the invitee's accept-and-welcome path,
an operator panel (funnel, revenue, organisations, payments, webhooks, activity), scheduled jobs (Stripe reconcile, archive abandoned set-ups), a go-live checklist on the
dashboard and subscription warning banners (payment failed, trial ending, set to cancel).

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (migrations through `20251203100000`, all SQL tests incl. `onboarding_accounts`, `onboarding_organisation`, `stripe_billing`, `invitations`, `platform_monitor`, `go_live_checklist`, guardrails, tenancy sweep) | pass |
| `npm run api:test` (154) / `api:test:e2e` (387, incl. API tenancy sweep) | pass |
| `npm test` (Vitest, 542+) · `npm run lint` (0 errors) · `npm run build` | pass |
| **`npm run journey`** (real web app + real API + migrated database, stand-ins for Supabase and Stripe): sign up → verify → sign in → start organisation → locked until paid → seats → fake Checkout → subscription applied (trialing, 3 seats) → wizard (details, department, security) → invite (Contributor seat reserved) → finish → dashboard; second browser: sign up → verify → sign in → accept → dashboard, seat kept; owner dashboard shows the go-live card and the payment-failed banner, not repeated on the billing page. Fails on any console error, page error or unexpected failed request. Screenshots reviewed (`/tmp/journey` by default). | pass |
| Mutation checks (ON6a): card shown when nothing required is open; payment-failed banner dismissible; trial warning window widened; banner on the billing page; card shown before the wizard is finished; details step reset on load | each caught by a test |
| Live project, **read-only**: `supabase/checks/guardrails.sql` | **0 violations** (migrations through `20251202100000` are live; `20251203100000` is not applied yet) |
| Live advisors (security) | no ERROR. WARN: `auth_leaked_password_protection` (**off: turn it on**, Auth → Providers → Email → password security) and 110 × `pg_graphql_authenticated_table_exposed` (every table is RLS-protected; the GraphQL endpoint is not used by the app, so this only makes table names discoverable to signed-in users — revoke is optional hardening, not done) |
| Live advisors (performance) | INFO 396 unindexed foreign keys, INFO 32 unused indexes, WARN 1 multiple permissive policies. Not addressed; none is a correctness or security issue at current data size |

## Found by the journey

- The **organisation details step wiped what a person had typed** when their typing came before the organisation's details had loaded (the saved values arrived as "nothing" and replaced the text). Fixed and covered by a unit test that fails on the old code. This is the kind of thing unit tests with synchronous mocks cannot see.

## Go-live runbook (in this order)

1. **Apply** `20251203100000_go_live_checklist.sql` to the live project (when you say). Everything else through ON5 is already live.
2. **Stripe, test mode first** (`docs/stripe-setup.md`): API project env `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL`, `CRON_SECRET`; webhook endpoint `https://<api>/api/v1/stripe/webhook`. **Webhook delivery has not been seen yet** (`stripe_events` was empty at last check): send a test event and confirm the operator **Webhooks** tab shows it processed.
3. **Run the test-mode checklist** in `docs/stripe-setup.md` §5 against the dev deployment (a purchase already worked; also: seat change with preview, cancel at period end, a failed payment with a test card, the Customer Portal, a webhook retry).
4. **Supabase Auth:** turn on **leaked password protection**; set the Site URL and redirect URLs for production, preview and local; confirm the built-in email limits are acceptable or add your own SMTP (sign-up and invitation mail depend on it).
5. **Operators:** add yourself (`insert into platform_admins (user_id) values ('<auth user id>')`) and enrol two-factor; open `/platform` and check all six tabs.
6. **Production deployment:** copy the env vars to Production with **live** keys only when step 3 is clean; add the live webhook endpoint; Vercel crons run on Production only.
7. **Switch the gate on:** `update public.platform_settings set value = 'true'::jsonb where key = 'billing_gate_enabled';` Existing organisations stay as they are (grandfathered); only new ones need to pay. To switch off, set it back to `'false'`.
8. After the first real sign-up, watch the operator panel: funnel, Webhooks (none stuck or failed), Payments.

## Limitations (honest list)

- **Not live-tested against Stripe or Supabase Auth.** The journey uses stand-ins for both, so it proves our code, not the services. Real signature verification is covered in the API tests; the real Stripe SDK calls follow Stripe's types but the webhook path has not run against Stripe.
- The journey checks the screens it drives at one viewport (1280×800), in Chromium only. Mobile layouts, Safari and Firefox have not been looked at; the email links (verify, invite) are simulated by marking the address verified.
- No email of our own: trial-ending and payment emails are Stripe's; verification and invitation mail are Supabase's.
- The go-live card disappears once the four required items are done, even if recommended ones (legal name and country, logo) remain.
- No tax/VAT number capture, no invoices PDF of our own (Stripe's are linked), no ownership transfer, no invitation domain rules, no SSO.
- GraphQL exposure, unindexed foreign keys and unused indexes (above) are not addressed.
- `npm run journey` needs Playwright with Chromium (preinstalled in this sandbox; otherwise `npm i -D playwright && npx playwright install chromium`) and Postgres server binaries, like `db:check`.
