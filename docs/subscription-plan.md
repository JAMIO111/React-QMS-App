# Subscription, billing and entitlements

Scope delivered: database, entitlement engine, API and Subscription & Billing settings page. Stripe, webhooks,
lifecycle jobs, grace-period notifications and cancellation are deferred (brief phases 4–6).

- **Two independent checks.** Effective access = company permission (RBAC) AND subscription entitlement.
  `app.has_permission` is RBAC AND MFA AND `app.has_entitlement`. Packages (observer/contributor/controller)
  are never roles or permission codes.
- **Catalogue (global, read-only):** `subscription_plans`, `subscription_prices` (pence, GBP, annual = 10 × monthly),
  `modules`, `features` (`permission_code` links a feature to an existing permission), `subscription_entitlements`
  (access level none/view/operational/full).
- **Tenant tables:** `organisation_subscriptions`, `organisation_subscription_items`, `user_subscription_assignments`
  (one active per membership, history kept), `billing_invoices`, `billing_payments`, `subscription_audit_logs`.
- **Billing permissions:** `subscription.read/.manage/.seats`, `invoices.read`, `payment_methods.manage`,
  `billing_details.manage` (owner and admin roles by default). They are not tied to any package.
- **Rollout switch:** `organisation_settings.entitlements_enforced` (default false, platform-controlled):
  `update organisation_settings set entitlements_enforced = true where organisation_id = '<id>';`
  Past due keeps access for `grace_period_days` (7), then `payment_overdue`.
- **Seats:** until a payment provider exists, `PUT /subscription/seats` (`subscription.manage`) sets purchased seats
  directly (manual provider). Assignments beyond purchased seats fail with `QM009` → `409 subscription_rule`.
- **API:** `api/src/billing/`. Frontend: `useSubscription.js`, `SettingsSubscription.jsx`, `RequireModule.jsx`
  (restriction page; menu items carry a `module`).
- **Known gap:** only modules with existing permissions (NCR, calibration, control plans, inspections) are mapped to
  features; the rest are seeded as `planned`.

## Seats and prices from November 2026 (migration `20260465100000_seats_and_prices_2026.sql`)

- **Four seat packages and one fee.** `subscription_plans.kind` is `seat` (observer, operator, contributor, controller) or `fee`
  (`organisation`: one per subscription, never given to a person, holds no entitlements). Prices (pence, excluding VAT; annual = 10 ×):
  organisation 9900, controller 4900, contributor 1900, operator 600, observer 0.
- **What each seat does.** Contributor now does the work (`ncr.update` and `capa.manage` are `operational`); Controller signs off and sets up
  (approve dispositions, verify and close 8Ds, delete NCs, configuration). Operator views everywhere and is `operational` for two features only:
  `ncr.create` and `inspection.record` (feature rows in `subscription_entitlements`, which win over the module row).
- **Guards for later migrations.** Trigger `subscription_entitlements_rules` drops any entitlement row for a fee plan and clamps an Operator
  module row above view down to view, so a migration that crosses every plan cannot give the fee access or the Operator more than view. A new
  feature the Operator should do needs its own feature row.
- **Free Observers.** `app.check_seat_change` refuses Observers above twice the paid seats (packages not named keep what the subscription has),
  except for an organisation still paying for Observers at the old price; it also refuses the fee named as seats. The screens stop the Observer
  `+` at the limit (`freeObserverLimit` / `observerProblem` in `src/lib/billing.js`).
- **Existing subscriptions keep their prices.** Old price rows are ended (`effective_to`) and keep their Stripe ids, so `stripe_apply_subscription`
  still maps them. `app.stripe_prices_for_plan(slug, interval)` (API login only) lists every Stripe id a package has had, current first; a seat
  change keeps the price an item already has and only a package new to the subscription takes today's price. Old subscriptions get no fee.
- **Checkout and invoiced starts add the fee** (`StripeBillingService.lineItems`: each seat chosen, then each `fee` plan with a current price, quantity 1).
  The overview's items carry `kind`; seat totals and the operator panel's `seats_purchased` count seats only; the recurring total includes the fee.
- **Which seat a permission needs** (`GET /permissions` `needs`, the role editor) is the cheapest seat whose feature row, else module row, reaches
  the feature's level: `ncr.create` → operator, `ncr.update` → contributor, `ncr.approve_disposition` → controller.
- **Stripe ids (2026-11-27).** Sandbox (`acct_1UZ4oXK5lGCrs5Si`): products Operator `prod_VhwHj3OPmplK1X`, Organisation `prod_VhwHVgsJlpYdG2`; prices organisation
  `price_1UgWPdK5lGCrs5SiQsNXTK8J` / `price_1UgWPgK5lGCrs5Si7jqee62L`, controller `price_1UgWP9K5lGCrs5Sipqv0iqzn` / `price_1UgWPCK5lGCrs5SiSvfDRqiv`,
  contributor `price_1UgWPFK5lGCrs5SizbnUaT4w` / `price_1UgWPLK5lGCrs5Si9vqYCjcc`, operator `price_1UgWPXK5lGCrs5SifpjkDBh8` / `price_1UgWPaK5lGCrs5SipBZ4Z8F6`,
  observer `price_1UgWPPK5lGCrs5SiyT0RU0mU` / `price_1UgWPTK5lGCrs5SiNufjHZyW` (month / year; the 2025 sandbox prices stay active for the subscription on them).
  Live (`acct_1UZ4npGSg4BqbNAb`): products Operator `prod_VhwIacQwASREbK`, Organisation `prod_VhwIBiZKPS3uQQ`; prices organisation `price_1UgWQlGSg4BqbNAbsY2tyr6R` /
  `price_1UgWQoGSg4BqbNAbsUPdZOAP`, controller `price_1UgWQNGSg4BqbNAbyNghN1U4` / `price_1UgWQQGSg4BqbNAbF7V1iFfF`, contributor `price_1UgWQTGSg4BqbNAbz1uU3b5X` /
  `price_1UgWQXGSg4BqbNAbsYN8Q2cy`, operator `price_1UgWQgGSg4BqbNAbAaTnTIeH` / `price_1UgWQjGSg4BqbNAbcYT0MPJB`, observer `price_1UgWQaGSg4BqbNAbeyehese6` /
  `price_1UgWQdGSg4BqbNAbAfv8L9v8` (the six 2025 live prices are archived: the live account had no subscriptions).
