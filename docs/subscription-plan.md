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
