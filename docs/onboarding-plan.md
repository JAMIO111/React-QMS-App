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
| **ON1 Sign-up and account states** (done 2026-11-07) | New sign-up + verification, "Start your organisation", `signup_events`, `platform_admins` + `/platform` shell | A stranger can sign up, verify, and reach "Start your organisation"; nothing else; funnel events recorded |
| **ON2 Organisation in a locked state + wizard shell** (done 2026-11-07) | `start_organisation`, `status`/`billing_required`, `organisation_onboarding`, wizard steps 1, 3, 4, 5 (details, sites & departments, security) with saved progress | Org exists but is unusable until subscribed; refresh/resume works; DB refuses business calls while locked |
| **ON3 Stripe subscription** (built 2026-11-07; test-mode run needs your keys) | Checkout + trial, server-side confirm, webhooks + `stripe_events`, Customer Portal, `subscription_valid` gate, lock page, Controller invariant, seat change with proration preview, billing UI | Test-mode purchase end to end; payment failure and recovery; lock/unlock; replayed and out-of-order webhooks safe; reductions and last-owner rules tested |
| **ON4 Team and roles** | Invitation upgrades, bulk invite, wizard step 6, `AcceptInvite` + member welcome, seat-aware invites with "buy more" | Invitee path works for new and existing accounts; seat and role rules enforced and explained |
| **ON5 Operator panel (monitor)** | Funnel, organisations, MRR/ARR, payments, webhook health, audit feed; cron endpoints (reconcile, abandoned set-ups, trial notices) | Panel shows live truth; cron safe to re-run; no tenant business data reachable |
| **ON6 Go-live and exit check** | Step 7 + checklist, lapse banners, docs, exit report, guardrails/sweeps, scripted browser run-through in Stripe test mode | Whole journey scripted end to end, no console errors, exit report written |

## 9. What I need from you (outside the code)

1. A **Stripe account** (test mode is enough to start): I create the products/prices with a script (three packages × monthly/annual in GBP) so you only supply the **secret key** and, once the Dev API URL is known, register the **webhook endpoint** and give me its **signing secret**.
2. The API's host must be able to reach `api.stripe.com` (and this environment's network allow-list too for my own tests; I will check and request it when we reach ON3).
3. Env vars on the Vercel Dev project: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, plus `APP_BASE_URL` for Checkout return links.
4. Terms of service and privacy policy URLs for the sign-up page (placeholders until you have them).

## 10. Answers (2026-11-07)

| # | Decision |
|---|---|
| O11 | **Prices unchanged:** GBP, £5 / £10 / £25 per seat per month, annual = 10 × monthly. |
| O12 | **VAT:** the most common SaaS approach: prices are shown **excluding VAT**; **Stripe Tax** calculates and adds VAT (and collects the customer's tax id) at checkout and on invoices, based on the billing address. Needs your tax registration set up in Stripe before live mode; in test mode it works with Stripe's test settings. |
| O13 | **Minimum purchase = 1 Controller seat.** An owner cannot have access to the app without it (O2). |
| O14 | **Cancellation at period end only** (Customer Portal); access continues until the period ends, then the lock (O5) applies. |
| O15 | **Retention defaults:** an unpaid set-up is archived after **14 days**; a cancelled/lapsed organisation's data is kept **90 days** before archiving. |

## 11. ON1 in detail: sign-up and account states

**Goal:** a stranger can sign up, verify their email, sign in, and reach "Start your organisation"; the operator can see that funnel. (The organisation is still created unlocked in ON1; the locked state and the gate arrive in ON2/ON3.)

- **Migration `20251128100000_onboarding_accounts.sql`:** `profiles.terms_accepted_at/terms_version` (from sign-up metadata, set by `handle_new_user`); `signup_events` (platform-owned; `signed_up | verified | org_started`, `kind` self|invited,
  written only by triggers on `auth.users` and `organisations`, backfilled from existing data); `platform_admins` (allow-list, seeded by SQL); `app.is_platform_admin()` (allow-list **and** an `aal2` session);
  `app.platform_funnel(days)` and `app.platform_recent_signups(limit)` (admin only). Both tables are reviewed global tables in the guardrails.
- **API:** `GET /platform/me`, `GET /platform/overview?days=` (unscoped, reviewed allowlist; `403 mfa_required` for an admin on a non-MFA session; `403` for everyone else).
- **Frontend:** new sign-up (name, work email, password with live rules, terms acceptance, inline errors, no enumeration), "check your email" screen with resend and cooldown, sign-in that explains an unverified account and resends,
  the first-run page rebuilt as **Start your organisation** (progress rail, pending invitations, organisation form), and `/platform` (funnel cards, period selector, recent sign-ups) visible only to platform admins.
- **Tests:** SQL (events by trigger, invited users excluded from the owner funnel, admin and MFA gating, no access for others), API e2e (admin, non-admin, no-MFA), Vitest for every new screen, mutation checks, guardrails and sweeps.
- **Needs from you later (not for ON1):** Stripe account and keys (ON3). Terms/privacy URLs come from `VITE_TERMS_URL` / `VITE_PRIVACY_URL` (placeholders until you have them).

## 12. ON2 in detail: the organisation in a gated state, and the wizard shell

**Goal:** an owner who has just started an organisation is taken through a saved, resumable wizard; the database can refuse everything except billing and set-up for an organisation that must have a subscription but has none; and none of that bites until the operator switches the billing gate on (ON3).

- **The gate is a switch.** `platform_settings.billing_gate_enabled` (default **false**, changed by SQL only). While false, new organisations behave exactly as today. While true, `app.start_organisation` marks the new organisation `billing_required`
  (and turns on `entitlements_enforced`). Existing organisations are grandfathered (`billing_required = false`). This lets ON2 ship safely before Stripe exists; ON3 turns it on.
- **The lock** is in the same functions every policy and route already use (`has_permission`, `has_permission_somewhere`, `my_permissions`): for a `billing_required` organisation without a valid subscription only the **billing permissions and `organisation.manage`** (set-up) are granted. `app.organisation_subscription_valid(org)` is the O2 test
  (status trialing/active, or past due inside the grace period, or cancelled but paid to period end; and a Controller seat assigned to an active Owner). `app.organisation_access_state(org)` tells the caller `open | needs_subscription | lapsed` (members only).
  The existing `organisations.status` (active/suspended) is untouched: a locked organisation is still visible to its members, which billing needs.
- **Start:** `app.start_organisation(name, site name/code, time zone, country, idempotency key)` wraps `create_organisation` (first site gets the time zone), records the wizard row, and applies the gate. `POST /organisations` calls it.
- **Wizard state:** `organisation_onboarding` (steps saved as done/skipped, current step; written only by `app.set_onboarding_step`/`app.complete_onboarding`, `organisation.manage`). Computed steps: *organisation* (done at start), *plan* (done when the subscription is valid; not required while the gate is off), *sites* (done when there is a site).
  Finishing needs *organisation*, *sites* and, when billing is required, a valid subscription.
- **API:** `GET /onboarding`, `PUT /onboarding/step`, `POST /onboarding/complete`; `/me` memberships carry `accessState` and `onboarding` (`none|in_progress|complete`); organisation `legalName` and `country` join the organisation settings.
- **UI:** `/setup` (full-screen wizard: Organisation, Plan & seats [placeholder until ON3], Details, Sites & departments, Security, Team [placeholder until ON4], Review & finish), resume from any device, "finish later"; the app sends the owner of an unfinished set-up to `/setup`; a "subscription needed" page for a gated organisation. The steps reuse the existing Settings components.
- **Tests:** SQL (gate off/on, lock set, valid/invalid subscriptions, Controller seat rule, idempotent start, step rules, isolation), API e2e, Vitest for the wizard, mutation checks, guardrails and sweeps.

## 13. ON3 in detail: Stripe subscription

**Goal:** an owner can buy Controller (and other) seats through Stripe Checkout with a 14-day trial, the app learns the result from Stripe itself, billing problems lock and unlock the organisation, and seats change through Stripe with a proration preview. Built so everything except the real calls to `api.stripe.com` is tested here (a fake gateway); the end-to-end test-mode run needs your keys (§9). Slices: **ON3a** database, **ON3b** API, **ON3c** UI + exit check.

**Design decisions (agreed defaults, flag any you want changed)**
- **Stripe is the source of truth for money and quantities; the database is the source of truth for who holds a seat.** We never write a Stripe-managed subscription from the browser or by hand: for an organisation with `billing_provider = 'stripe'` (and for any `billing_required` organisation) `app.set_subscription_seats` is refused (`QM009`), which closes the self-grant gap from ON2. Existing manual-billing organisations are unchanged.
- **System writes** (webhook, confirm, reconcile) go through SECURITY DEFINER functions `app.stripe_*` executable **only by the `qms_api` login** (revoked from `authenticated`/`anon`), so no signed-in user can call them. The API verifies the Stripe signature on the **raw body** first; the DB functions trust only that caller.
- **Always apply fetched state, never the event payload.** A webhook only says "something changed"; the API re-fetches the subscription (and invoice) from Stripe and applies it with a `fetchedAt` stamp. `app.stripe_apply_subscription` ignores a snapshot older than the one already stored (`provider_synced_at`), takes a row lock per organisation, and is idempotent, so replayed, duplicated and out-of-order events and the Checkout confirm racing the webhook are all safe.
- **`stripe_events`** (platform-owned, one row per Stripe event id, status received/processed/failed/ignored, error text) makes handling idempotent and observable (operator panel in ON5). Failures return 500 so Stripe retries; a duplicate id returns 200 without redoing work (unless the earlier attempt failed).
- **Prices:** `subscription_prices.provider_price_id` maps our price rows to Stripe prices; `scripts/stripe-setup.mjs` creates the products and the six GBP prices (`tax_behavior: exclusive`, lookup keys `fortress_<plan>_<interval>`) idempotently and writes the ids with SQL you review. **VAT:** Checkout uses Stripe Tax (`automatic_tax`, billing address and tax id collection).
- **Checkout:** `mode=subscription`, one line per package with quantity, `trial_period_days=14`, `payment_method_collection=always`, `client_reference_id`/`metadata.organisation_id`, success URL `/setup/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancel URL back to the plan step. At least 1 Controller seat; the interval is monthly or annual. A customer per organisation (`billing_customers`), created once.
- **Confirm:** `POST /billing/checkout-session/confirm` retrieves the session from Stripe, checks it belongs to this organisation and was started by this person, then applies the subscription. The first apply gives the person who started checkout (an active Owner) a Controller seat.
- **Controller invariant** (organisations with `billing_required`, while the subscription is valid): a deferred constraint trigger refuses any change that would leave no active Owner holding a Controller seat (ending that assignment, downgrading it, removing the Owner role, suspending the member). Controller seats cannot be reduced below the seats in use or to 0.
- **Seat changes:** `POST /billing/seats/preview` asks Stripe for the proration (`invoices.createPreview`) and returns lines and amount due; `PUT /subscription/seats` for Stripe organisations updates the Stripe subscription (`proration_behavior=create_prorations`, idempotency key), then fetches and applies. Reductions below assignments are refused before Stripe is called (message names the count). Portal: `POST /billing/portal-session` (cancellation at period end only, card, invoices, tax details).
- **Status mapping:** Stripe `trialing/active/past_due/unpaid/paused/incomplete` map 1:1, `canceled` → `cancelled`, `incomplete_expired` → `cancelled`. `past_due_since` is set when it becomes past due and cleared when it recovers. Validity is the ON2 rule (trial/active, past due in grace, cancelled until period end, and an Owner Controller seat).
- **Quantity lower than assignments after a Stripe-side change** (e.g. via the Portal): applied as Stripe says, recorded in the audit log, shown as "over by N" in the UI; nothing is unassigned automatically.
- **Not in ON3:** invitations and wizard step 6 (ON4), the operator panel's billing views and cron reconcile endpoint (ON5; the apply functions are already reusable by it), lapse banners beyond the basics (ON6).
- **Without keys:** `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`APP_BASE_URL` are optional env; unset, billing routes answer `503 billing_unavailable` and the overview says `checkoutAvailable: false`, so the app and tests run unchanged.

**Tests:** SQL (apply idempotency, stale snapshot ignored, status mapping and `past_due_since`, owner seat on first apply, invariant, seat reduction rules, manual seats refused, privileges: `authenticated` cannot call the system functions, isolation), API e2e with a fake gateway and **real signature verification** (checkout, confirm ownership, webhook valid/invalid/duplicate/replay/out-of-order, seat preview/update, portal, 503 without keys), sweeps, Vitest for the plan step and billing page, mutation checks on the migration.

## 14. ON4 in detail: team and roles

**Goal:** an owner can invite their team in the wizard (or later in Settings), choosing role, departments and package (seat) for each person with the seats left shown live; invitations expire, can be resent and revoked; an invited person has a proper path in (email → password → "you have been invited as…" → accept → welcome). Slices: **ON4a** database + API, **ON4b** screens.

**Decisions (defaults; say if you want any changed)**
- **A seat is reserved when the invitation is sent** (if a package was chosen). It frees when the invitation is revoked; the person keeps it when they accept. An invitation that expires still holds its seat until it is revoked or resent, and is shown as expired. Choosing a package needs `subscription.seats` (owners and admins have it); without it the person is invited with no package and one can be assigned later. Never more seats than bought: the existing capacity rule (`QM009`) applies.
- **Invitations last 14 days** (`invite_expires_at`); resend extends to 14 days from now; at least 60 seconds between sends and at most 10 sends (`QM015` → `429`-style `409 invitation_rule`); an expired invitation cannot be accepted (`my_invitations` still lists it, flagged expired, so the person sees why).
- **Written only by functions:** the invitation row itself is still inserted under RLS as today; the new details (message, expiry, send counters, seat) are set by `app.set_invitation_details`, resend by `app.resend_invitation`, revoke by `app.revoke_invitation` (needs `members.manage` and `app.can_manage_membership`, releases the reserved seat). `app.accept_invitation` refuses expired and revoked invitations.
- **Bulk invite:** up to 50 people per request, each independent (a bad row never stops the others); the answer lists one result per row (invited, with the email outcome, or the reason it was not).
- **Email:** Supabase invite for a new address (as now). For an address that already has an account, the API now sends a Supabase **sign-in link** that lands on `/accept-invite` (before, such people were not emailed at all). Both are optional (`SUPABASE_SERVICE_ROLE_KEY`); a failed email never loses the invitation, and the screen says whether it was sent.
- **Invitee path:** `/set-password?mode=invite` (set a password) now ends at **`/accept-invite`**: it asks for their name if the profile has none, shows each invitation ("**Org** invited you as **Role**, in **Departments**, with a **Package** seat. From Name: message"), accepts one, and shows a **welcome** (your role and what it lets you do, your package, set up two-factor if the organisation requires it, and where to start). No payment and no organisation creation on this path.
- **Not in ON4:** ownership transfer, invitation domain rules, funnel events for first invite/accept (ON5 adds them to the operator panel), email templates of our own.

**Tests:** SQL (details, expiry, resend limits, revoke frees the seat, accept refuses expired/revoked, permissions, isolation), API e2e (single and bulk invites with seats, partial success, resend/revoke, accept flows, invitee view, sweeps), Vitest (team step, results table, seats left, accept/welcome, Settings changes), mutation checks.
