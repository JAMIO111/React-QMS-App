# Onboarding: self-serve sign-up, Controller subscription, organisation set-up, seats, team and roles

**Status:** DRAFT v2 for agreement · **Date:** 2026-11-07 · **Branch:** `Dev`
**Authority:** `docs/design-brief.md` (multi-tenancy, security, subscriptions), `docs/subscription-plan.md`, `docs/phase-1-plan.md` (onboarding).
**Supersedes v1** (sign-up codes and operator-approved seat orders were dropped: an owner gets started without any action from the operator).

## 1. What exists today (inspected)

- **Sign-up** (`SignUp.jsx`): open email + password sign-up, no name, no terms, `alert()` errors, no verification states. **First run** (`NoOrganisation.jsx`): a one-field "Create organisation"
  (`app.create_organisation`: organisation, first site, owner membership, system roles, settings; idempotent) or pending invitations. Then the dashboard, with nothing set up.
- **Members** (`api/src/members`): invite with roles and departments, optional Supabase invite email, accept, role assignments, departments.
- **Subscriptions** (`api/src/billing`, migration `20251110100000`): packages Observer / Contributor / Controller (£5 / £10 / £25 per seat per month, annual = 10 × monthly, GBP), seats, one active assignment per member,
  `QM009` when assignments exceed seats, statuses incl. `past_due`/`unpaid`, grace period (7 days), `entitlements_enforced`. **The tables already carry Stripe columns** (`billing_provider`,
  `provider_customer_id`, `provider_subscription_id`, invoices/payments with provider ids) but nothing writes them: seats are set by hand (`PUT /subscription/seats`).
- **Gap:** no payment, no gate, no guided set-up, nothing tells an owner whether the organisation is ready, no operator view.

## 2. Decisions (from the planning questions, 2026-11-07)

| # | Decision |
|---|---|
| O1 | **Open sign-up, no codes, no approval.** The operator is never in the owner's critical path. |
| O2 | **To get started the owner needs a valid Controller subscription**, and must keep one. "Valid" = the organisation's subscription is `trialing`, `active`, or `past_due` inside the grace period, **and** at least one Controller seat is assigned to an active member holding the Owner role. |
| O3 | **Stripe** (hosted Checkout for the first purchase, Customer Portal for card/invoices/cancellation, webhooks to sync). Card data never touches our servers. Built and tested in Stripe **test mode** first. |
| O4 | **14-day trial, card required** (Stripe `trial_period_days`). `trialing` counts as valid. Billing starts automatically at the end unless cancelled. |
| O5 | **When the subscription stops being valid: lock to billing only.** Everyone sees a "subscription needed" page; only people with billing permissions (owner, admin) reach Billing to fix it. Data is untouched and returns the moment it is valid again. Warnings during the grace period. |
| O6 | **Operator panel = monitor only** (`/platform`, platform admins only, MFA required): sign-up funnel, organisations, subscription status, seats, MRR, failed payments, webhook health, audit feed. **No actions.** It never reads tenant business data. |
| O7 | **Guided full-screen wizard** for the first run, saved on the server, resumable, with a go-live checklist afterwards. |
| O8 *(default)* | Existing organisations (test data) are **grandfathered**: `billing_required = false`, wizard and gate do not apply. New organisations get `billing_required = true`. |
| O9 *(default)* | One account can belong to several organisations (already true). Invited members never pay or subscribe themselves: their seat comes from the organisation's subscription. |
| O10 *(default)* | Email now = Supabase (verification, invitations) + Stripe's own receipts and trial-ending notices. No new email infrastructure in this build. |

## 3. The journey

```
 /signup ─► verify email ─► sign in ─► Start your organisation ─► Plan & seats (Stripe Checkout, card, 14-day trial)
                                           (name, time zone,            │ webhook + server-side session check
                                            first site)                 ▼
                       org exists, status "setting up", locked   subscription valid, owner gets a Controller seat
                                                                        ▼
                       WIZARD: 3 Organisation details → 4 Sites & departments → 5 Security → 6 Team & roles → 7 Review & go live
                                                                        ▼
                                   dashboard Go-live checklist until complete · Settings → Subscription for seats later
```

### 3.1 Sign-up and verification
- `/signup`: name, work email, password (strength meter), accept terms/privacy, optional "how did you hear" (funnel data). Clear inline errors (no `alert()`), no user enumeration, rate limited, CAPTCHA hook point.
- Verification screen with resend (rate-limited) and "wrong email? start again". Unverified accounts cannot create an organisation. Invited people use the invitation path (§3.6), not this one.
- A signed-in user with **no organisation and no invitation** lands on **"Start your organisation"** (replaces the generic no-organisation page): name, country, time zone, first site. Pending invitations are listed above it.

### 3.2 Organisation created in a locked state
- `app.start_organisation(...)` (idempotent, as `create_organisation` today) creates the organisation with `status = 'setting_up'`, `billing_required = true`, the owner membership and system roles. Until a valid subscription exists the
  organisation is **only reachable through the wizard's plan step and Billing**; everything else is refused by the database (same gate as O5), so an unpaid organisation can never be used by calling the API directly.
- Abandoned set-ups (no subscription after N days) are archived by a scheduled cleanup (Vercel Cron → API endpoint protected by a secret); the account survives and can start again.

### 3.3 Plan and seats (Stripe Checkout)
- The owner chooses **Controller seats (minimum 1, the owner takes one)**, optional Contributor and Observer seats, monthly or annual. The page shows each line, the trial end date, the price after the trial, "VAT added at checkout" (see Q2).
- `POST /billing/checkout-session` creates a Stripe Checkout Session (`mode=subscription`, one line per package, `subscription_data.trial_period_days=14`, `payment_method_collection=always`, customer email prefilled,
  billing address collected, `metadata.organisation_id`) and returns its URL. Success returns to `/setup/subscribed?session_id=…`; cancel returns to the plan step with the choices kept.
- **We do not trust the redirect or wait only for the webhook:** the success page asks the API to **retrieve the session from Stripe server-side** and apply it (idempotently), while the webhook does the same; whichever arrives first wins, the other is a no-op.
  The page shows "setting up your subscription…" with a timeout and a retry, never a blank state.
- On success: provider ids stored, seats = purchased quantities, status `trialing`, the owner is **auto-assigned a Controller seat**, organisation `status = 'active'`, wizard unlocks.

### 3.4 The wizard (`/setup`, server-saved `organisation_onboarding`)
| Step | What the owner does | Required |
|---|---|---|
| 1 Organisation | Name, country, time zone, first site (before payment) | name, time zone |
| 2 Plan & seats | §3.3 | valid subscription |
| 3 Details | Legal name, logo, theme colour, working week | – |
| 4 Sites & departments | Rename/add sites, tick suggested departments, paste a list | ≥ 1 site |
| 5 Security | Require MFA for everyone (explained), enrol their own MFA now | owner enrolled if MFA required |
| 6 Team & roles | Add people (paste emails or one by one): role(s), department(s), **package per person**, live "seats left", send invitations; buy more seats inline | – |
| 7 Review & go live | Summary, what is open, finish | steps 1, 2 and 4 done |
Every step: back/next, autosave, skip where allowed, refresh-safe, resumable from another device, keyboard and screen-reader friendly, with loading, empty and error states.

### 3.5 Seats afterwards (Settings → Subscription; the wizard uses the same component)
- Quantity per package with a **proration preview from Stripe** before confirming; confirm updates the Stripe subscription; the webhook confirms; the UI shows "updating…" until then. Increases are immediate; reductions cannot go below current assignments (clear message naming who to unassign).
- Controller invariant: you cannot reduce Controller seats to 0, unassign the last Controller seat from the last Owner, or remove/downgrade the last Owner. Ownership transfer requires the new owner to hold a Controller seat.
- **Customer Portal** link for payment method, invoices, tax details and cancellation (cancel at period end keeps access until then). Invoices and payments mirror into `billing_invoices` / `billing_payments`.
- Payment failure: `invoice.payment_failed` → `past_due`, in-app banner for owners/admins immediately, grace 7 days (existing setting), then lock to billing (O5). A successful payment restores access at once.

### 3.6 Inviting people and assigning roles
- Invitation: email, role(s), department(s) (existing rules), **package** (optional, assignable later), message. Expires (14 days), resend (rate-limited), revoke, bulk add with a per-row result (partial success is explained, never silent).
- **Invitee path:** email → `/accept-invite` → create account (name, password) or sign in → shown "You have been invited to **Org** as **Role**" → accept → **member welcome** (what you can do, your package, set up MFA if required, where to start) → app.
  No payment, no organisation creation.
- Inviting with no free seat of the chosen package: owners get "Buy another seat" (opens §3.5); admins get "ask an owner". The last-owner and department-required rules apply as today.

### 3.7 Go-live checklist (dashboard card for owners/admins)
Subscription valid · organisation details · logo · site · departments · security decision · another person invited · another person accepted · first non-conformance (optional). Computed from real data, linked to where it is done, hidden when the required items are complete.

## 4. Data model (new/changed; all lifecycle writes through SECURITY DEFINER functions, RLS, audited, in guardrails and sweeps)

- `organisations`: `status` (`setting_up|active|locked|archived`), `billing_required`, `onboarding_completed_at`. `organisation_onboarding` (step statuses, resume pointer).
- `organisation_subscriptions` (existing): populated by Stripe sync; add `trial_ends_at`, `cancel_at_period_end`, `current_period_end`, `latest_invoice_status`. `organisation_subscription_items` seats from Stripe quantities.
- `stripe_events` (platform-owned): `event_id` unique, type, received_at, processed_at, status, error; makes webhook handling idempotent and observable. `stripe_checkout_sessions`: session id, organisation, requested seats, status.
- `billing_profiles`: legal name, billing contact, address, VAT number (mirrors Stripe customer). `signup_events` (funnel): signed_up, verified, org_started, checkout_started, subscribed, first_invite, first_accept.
- `platform_admins` (seeded by SQL, MFA required).
- Invitations gain `package_slug`, `expires_at`, `revoked_at`, `message`, `last_sent_at`, `send_count`.
- `app.subscription_valid(org)`: the O2 test, cheap (indexed reads) because RLS calls it per row. `app.has_permission` consults it for organisations with `billing_required`; billing permissions stay allowed while locked so the owner can fix it.
- Errors `QM014` → `409 onboarding_rule`; outbox events for every step (`signup.verified`, `organisation.started`, `subscription.activated|past_due|locked|cancelled`, `seats.changed`, `invitation.sent|accepted|revoked`).

## 5. API (`api/src/onboarding/`, `api/src/billing/`, `api/src/platform/`)

Authenticated, no organisation yet: `POST /organisations/start`, `GET /onboarding`. Organisation-scoped: `PUT /onboarding/steps/{step}`, `POST /onboarding/complete`, `GET /onboarding/checklist`,
`POST /billing/checkout-session`, `POST /billing/checkout-session/{id}/confirm` (server-side retrieve + apply), `POST /billing/seats/preview`, `PUT /billing/seats` (now Stripe-backed), `POST /billing/portal-session`,
`POST /invitations/bulk`, `POST /invitations/{id}/resend|revoke`, `POST /members/{id}/transfer-ownership`. Public: `POST /stripe/webhook` (signature-verified, raw body, idempotent, replay-safe).
Scheduled (secret-protected): `POST /internal/cron/reconcile` (re-sync subscriptions from Stripe, catch missed webhooks), `…/abandoned-setups`, `…/trial-notices`. Platform admin (read-only): `GET /platform/overview|funnel|organisations|payments|webhooks|audit`.
Every route is `@OrganisationScoped` or on the reviewed allowlist (webhook, cron, platform) with its own isolation tests.

## 6. Frontend

`src/components/onboarding/` (wizard, steps, `SeatPicker` shared with Settings → Subscription, `TeamInvite` shared with Settings → Users, `GoLiveCard`, "subscription needed" lock page), new `SignUp` + verification + `AcceptInvite` + member welcome,
`src/components/platform/` (monitor-only screens, charts from the validated `--chart-*` tokens). Existing patterns: `MenuCard`, required `*`, refresh-after-action, optimistic UI for small saves, glass dialogs, Lucide icons.

## 7. Security and failure handling

- Stripe: webhook signature check on the **raw body**, event-id idempotency, tolerance for out-of-order events (always re-fetch the subscription from Stripe before writing), secrets only in server env (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids), never in the client bundle.
- Gate is in the database (O5), not only the UI. Tenancy sweeps (SQL and API) cover every new table and route; the platform area reads aggregates and its own tables only.
- Designed-in failures: double-click/refresh (idempotency keys), abandoned checkout (choices kept, resumable), webhook lost or late (confirm + cron reconcile), card declined at the end of the trial (grace then lock), seat reduction below assignments, last owner,
  invite with no seat, subscription cancelled while a wizard is open, duplicate sign-up email, expired/revoked invitations.

## 8. Delivery slices (each complete and tested before the next; applied live and pushed only when you say so)

| Slice | Content | Done when |
|---|---|---|
| **ON1 Sign-up and account states** | New sign-up + verification, "Start your organisation", `signup_events`, `platform_admins` + `/platform` shell | A stranger can sign up, verify, and reach "Start your organisation"; nothing else; funnel events recorded |
| **ON2 Organisation in a locked state + wizard shell** | `start_organisation`, `status`/`billing_required`, `organisation_onboarding`, wizard steps 1, 3, 4, 5 (details, sites & departments, security) with saved progress | Org exists but is unusable until subscribed; refresh/resume works; DB refuses business calls while locked |
| **ON3 Stripe subscription** | Checkout + trial, server-side confirm, webhooks + `stripe_events`, Customer Portal, `subscription_valid` gate, lock page, Controller invariant, seat change with proration preview, billing UI | Test-mode purchase end to end; payment failure and recovery; lock/unlock; replayed and out-of-order webhooks safe; reductions and last-owner rules tested |
| **ON4 Team and roles** | Invitation upgrades, bulk invite, wizard step 6, `AcceptInvite` + member welcome, seat-aware invites with "buy more" | Invitee path works for new and existing accounts; seat and role rules enforced and explained |
| **ON5 Operator panel (monitor)** | Funnel, organisations, MRR/ARR, payments, webhook health, audit feed; cron endpoints (reconcile, abandoned set-ups, trial notices) | Panel shows live truth; cron safe to re-run; no tenant business data reachable |
| **ON6 Go-live and exit check** | Step 7 + checklist, lapse banners, docs, exit report, guardrails/sweeps, scripted browser run-through in Stripe test mode | Whole journey scripted end to end, no console errors, exit report written |

## 9. What I need from you (outside the code)

1. A **Stripe account** (test mode is enough to start): I create the products/prices with a script (three packages × monthly/annual in GBP) so you only supply the **secret key** and, once the Dev API URL is known, register the **webhook endpoint** and give me its **signing secret**.
2. The API's host must be able to reach `api.stripe.com` (and this environment's network allow-list too for my own tests; I will check and request it when we reach ON3).
3. Env vars on the Vercel Dev project: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, plus `APP_BASE_URL` for Checkout return links.
4. Terms of service and privacy policy URLs for the sign-up page (placeholders until you have them).

## 10. Open questions

1. **Currency and prices:** keep GBP, £5 / £10 / £25 per seat per month and annual = 10 × monthly? (Stripe Prices are created from these.)
2. **VAT / tax:** use **Stripe Tax** (automatic, needs your tax registration set up in Stripe) or add tax later and show "VAT added at invoice" for now?
3. **Minimum purchase:** is 1 Controller seat the only minimum, or do you want a minimum number of seats in total?
4. **Cancellation:** cancel at period end only (default), or also let owners cancel immediately with a pro-rata refund?
5. **Archived organisations:** after how many days of an unpaid set-up do we archive it (default 14), and after a subscription is cancelled how long do we keep the data before archiving (default 90)?
