# Pay by invoice (self-serve) — plan

Status: **planned, not built.** I9 (abuse limits) agreed 2026-11-26; I1–I8 are proposed until the owner confirms them. Written 2026-11-26.
Related: `docs/onboarding-plan.md` §13 (Stripe), `docs/stripe-setup.md`, `docs/subscription-plan.md`.

## 1. What this is

Today an organisation can only pay by card: the plan step opens Stripe Checkout (`mode=subscription`, `payment_method_collection=always`, 14-day trial) and Stripe charges the card at each renewal.
Many companies cannot or will not put a card on a supplier's site: they pay a **bank transfer against an invoice**, often through accounts payable and with a purchase order number.

Self-serve invoicing means an owner can choose **Pay by invoice** on the plan step, give company billing details, and have a subscription that Stripe bills by **emailing an invoice** (hosted page with UK bank-transfer details, card still possible) due in N days. No person at Fortress is involved.

## 2. Why this is more than a switch

- **Stripe Checkout cannot do it.** Checkout in subscription mode always collects a payment method; it has no `send_invoice` option. So the invoice path does **not** use Checkout: Fortress collects the billing details in its own form and the API creates the customer details and the subscription directly (`subscriptions.create` with `collection_method: 'send_invoice'`, `days_until_due`).
- **Nothing proves the customer will pay.** A card at least exists; an invoice is a promise. Access policy, abuse limits and what "overdue" does to access must be decided on purpose (§3).
- **Stripe's overdue behaviour decides how access is cut off** and is the one thing to measure before building (§6, step 0).
- Seats, proration, the Customer Portal, tax, webhooks and the database gate were all written with a card in mind and each needs checking for an invoiced subscription (§5).

## 3. Decisions proposed (owner to confirm)

| # | Decision | Proposal | Why |
|---|---|---|---|
| I1 | Trial | **No trial for invoiced subscriptions.** Access starts when the subscription is created; the first invoice is issued at once, due in 14 days. | A trial with no card is 14 free days with nothing at stake. The card route keeps its trial. |
| I2 | Payment terms | **14 days** (`days_until_due`), fixed in code, not chosen by the customer. | Common default. Longer terms can be set by us later per organisation. |
| I3 | Intervals | **Annual and monthly** both allowed. | Monthly invoices are admin-heavy for the customer but it is their choice; annual is nudged in the copy. |
| I4 | When it is overdue | Access follows the **existing past-due grace** (`grace_period_days`, default 7) counted from the due date, then the organisation is locked as for a failed card. | One rule for both payment routes, already built and tested. |
| I5 | Who may choose it | Any **owner**, but only after entering **legal company name, billing address and a billing email**; VAT number optional. An operator can switch it off for an organisation (`invoice_billing_allowed`, default on). | Self-serve, with a company on the invoice and a stop for abuse. |
| I6 | Changing route | An organisation may move **from card to invoice and back** only at a renewal, from the Subscription page, by cancelling at period end and starting the other kind (no live switching of a running subscription's collection method in the first version). | Avoids half-states; Stripe supports switching but the edge cases (open invoices, proration) are not worth it yet. |
| I7 | Purchase order | Optional **PO reference** on the form, put on every invoice (Stripe invoice custom field). | The most common thing accounts payable ask for. |
| I8 | Seat changes | Extra seats are **added to the next invoice** (prorated), not invoiced instantly; removing seats credits the next invoice. | Matches how invoiced customers expect to be billed; avoids a surprise mid-month invoice. Cost: extra seats are in use before they are billed. |
| I9 | Abuse limits (agreed 2026-11-26, see §3a) | Seat cap until the first invoice is paid; data-leaving features closed while it is unpaid; 3 days' grace for invoiced customers; one invoiced organisation per company; operator alerts. | Keeps the self-serve start while capping the worst case at the seats on one invoice. |

## 3a. Abuse limits (I9)

The worst case without limits is up to 21 days of use (14 to pay + 7 grace) with nothing paid, repeated with new organisations. The agreed limits:

1. **Seat cap until the first invoice is paid.** An invoiced organisation can hold only the seats on its first invoice. While **any** invoice is open or overdue, `app.check_seat_change` refuses a seat increase (`QM009`, "pay the open invoice first"); decreases are always allowed. After the first invoice is paid the cap is lifted.
2. **Data-leaving features closed while the first invoice is unpaid:** creating **reporting keys** (Power BI), **activating or running integrations that write out**, and **bulk CSV exports** answer "available once your first invoice is paid". Reading in the app, importing data in, and everything else stay open. Worked out by one database function, `app.invoice_first_payment_pending(org)` (true for an invoiced organisation whose first invoice is not yet paid), so every screen and route asks the same thing.
3. **Shorter grace for invoiced customers: 3 days** after the due date (card customers keep 7). Stored as the organisation's `grace_period_days` when the invoice subscription is applied; the validity rule in §4.3 uses it.
4. **One invoiced organisation per company.** The legal name (ignoring case and punctuation) and the VAT number are kept on the subscription; a second organisation choosing invoice with the same VAT number, or the same legal name, is refused with "an organisation for this company already exists: ask its owner to invite you". The VAT number must verify with Stripe (Stripe checks UK and EU numbers when a tax id is added) before the subscription is created. An operator can lift the block for a genuine second entity.
5. **Operator alerts.** A notice to platform operators when an organisation starts an invoiced subscription, and when its **first** invoice passes its due date; both also appear on the `/platform` organisations tab (route, first invoice paid or not, overdue days). Never emailed to the customer.

**Not built (kept for if real abuse appears):** refusing free-mail billing addresses, pay-first access (nothing until the first invoice is paid), operator approval of the first invoice, a card on file as a fallback, archiving unpaid invoiced organisations sooner than the existing job does.

## 4. Design

### 4.1 The customer's path
Plan step (wizard) and Settings → Subscription → Start subscription gain a first choice: **Pay by card** (today, with the 14-day trial) or **Pay by invoice**.
Invoice path: choose seats and interval as now → **Billing details** form (company name, address, billing email, optional VAT number and PO reference, a plain-words summary "We will email an invoice for £X to Y, payable within 14 days by bank transfer or card; your seats are available now") → **Start subscription** → the same confirmation/summary as a card customer, plus the first invoice (amount, due date, **Pay this invoice** link to Stripe's hosted page, bank details).

### 4.2 API (`api/src/billing/`)
- `POST /billing/invoice-subscription` (owner only, `subscription.manage`; strict body: `seats`, `interval`, `company {name, address…, email, vatNumber?}`, `poReference?`, `clientKey`).
  1. Same guards as `checkout()`: owner, no live subscription, `assertNoSeatProblems`, prices from `app.stripe_price_for`, `invoice_billing_allowed`.
  2. Update the Stripe customer (name, email, address) and add the tax id (`customers.createTaxId`; an invalid number is a form error, not a silent drop).
  3. `subscriptions.create({ collection_method: 'send_invoice', days_until_due: 14, automatic_tax, payment_settings: { payment_method_types: ['customer_balance','card'], payment_method_options: { customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'gb_bank_transfer' } } } }, metadata, … }, { idempotencyKey })`, the first invoice finalised at once, PO reference as an invoice custom field.
  4. Re-read the subscription from Stripe and apply it through the existing `syncSubscription` (Stripe stays the source of truth; a retry with the same `clientKey` returns the same subscription).
- `StripeGateway` gains `createInvoiceSubscription(...)` and `updateCustomerBilling(...)`; `SubscriptionSnapshot` gains `collectionMethod` and `daysUntilDue`; `toSubscriptionSnapshot` maps them. The fake gateway in tests gets the same methods.
- `SubscriptionOverview` gains `paymentRoute: 'card' | 'invoice'`, `billingContact`, `purchaseOrder`, and `openInvoice {id, number, amountDue, dueOn, hostedUrl}` (from the latest open invoice) so the page can show what is owed.
- The webhook list already covers `invoice.*`; add `invoice.overdue` is **not** an event Stripe sends reliably, so overdue is worked out in the database (§4.3), not from an event.

### 4.3 Database (one migration)
- `organisation_subscriptions`: `collection_method text` (`card` default | `invoice`), `payment_terms_days`, `billing_contact_email`, `purchase_order`. `organisations`/settings: `invoice_billing_allowed boolean default true` (platform-owned; set by the operator).
- `invoice_first_payment_pending(org)`, the one-per-company check (`billing_company_key` = normalised legal name, `vat_number`, unique among live invoiced subscriptions unless an operator lifts it with `app.set_invoice_company_exempt`), the seat rule in `app.check_seat_change` and the operator notices of §3a (event `platform_invoice_alerts`, written by `app.stripe_apply_subscription` and the daily reconcile).
- `app.stripe_apply_subscription` takes the new snapshot fields (patched from its live definition with `pg_temp.patch_once`, marker-guarded, as the other migrations do).
- **Validity for an invoiced subscription** (`app.organisation_subscription_valid`): valid while `active`, and **not valid when the oldest open invoice's due date + grace is in the past** — even if Stripe still says `active`. This makes access independent of exactly how Stripe labels an overdue send-invoice subscription (§6 step 0 tells us whether it is also needed for `past_due`). Needs `billing_invoices.due_on` (check it is stored; add if not) and an index for the lookup.
- **Controller invariant and `QM009` seat rules are unchanged** (the first Controller seat goes to the owner who started it: record the starter as `stripe_start_checkout` does, with a synthetic checkout id, or add the user id parameter).
- Operator functions: `app.set_invoice_billing_allowed(org, allowed, reason)` (platform admin, audited); the operator panel's organisations tab shows the route and any overdue invoice.
- Tests: SQL test for validity (open invoice just before due → valid; past due + grace → locked; paid → valid again; card route unaffected), idempotent apply, a card customer never reads as invoiced.

### 4.4 Seats and the rest of billing
- `previewSeats` / `changeSeats` already go through Stripe; for `send_invoice` the proration lands on the **next invoice** (`proration_behavior: 'create_prorations'` is already what we use), which is I8. The preview copy must say "added to your next invoice", not "charged now" (`amountDue` is not what is payable today).
- **Customer Portal:** for invoiced customers it shows invoices and billing details; "update payment method" is meaningless. Keep the portal configuration as is and hide the "payment method" wording on our own page for the invoice route.
- **Stripe Tax:** unchanged (`automatic_tax`); a tax id entered on the form is what lets a VAT-registered business be invoiced correctly.
- **Reminders and dunning:** use Stripe's own invoice emails (send on finalise, reminder before due, overdue reminder) — turn on in the Stripe dashboard (Billing → Subscriptions and emails). Fortress adds an in-app banner (`SubscriptionBanner`): "Invoice INV-… for £X is due on …" and, once overdue, "access stops on …" (reuses `subscriptionWarning`).
- **Failure to pay:** past grace the organisation is locked exactly as a failed card is today (`SubscriptionNeeded` / `lapsed`); paying the invoice (Stripe marks it paid → webhook → re-read) unlocks it at once.

### 4.5 Frontend
`PlanStep` and Settings → Subscription: payment route choice (`SlidingToggle`, two options with a one-line explanation each); `BillingDetailsForm` (custom pickers, country combo, validation, required marks); Subscription page shows the route, the open invoice with **Pay this invoice** and **Download**, and "Next invoice" for card customers as today; `lib/billing.js` remembers the choice across a cancelled step as it does for seats. Wizard Review says "Invoice, payable within 14 days" for the plan card. Optimistic UI does not apply (creating a subscription is a step Stripe decides); the button uses `loading`.

## 5. What must be re-checked, not assumed
1. How Stripe labels a send-invoice subscription whose invoice is unpaid after the due date (`active`, `past_due`, `unpaid`) — and what its dashboard setting "Manage unpaid invoices" does.
2. The first invoice's timing when the subscription is created (it should finalise immediately, not at the next hour).
3. Invoice settings: PO custom field, bank-transfer details for `gb_bank_transfer` on the account (needs the payment method enabled on the Stripe account; GB bank transfer is available to UK accounts), currency GBP only.
4. Proration on a seat increase for `send_invoice` (pending invoice items, not an immediate invoice).
5. Cancellation at period end and the final invoice.
6. Everything in `docs/stripe-setup.md` §5, repeated for the invoice route in the sandbox, then the live account.

## 6. Slices

| Slice | Content | Done when |
|---|---|---|
| **IV0 spike (sandbox, no app code)** | Create an invoiced subscription by script in the sandbox; record what Stripe does when unpaid (status, events, emails), bank-transfer details, proration on a seat change, cancel at period end. Settles §5 and decides whether the database rule in §4.3 is needed beyond `past_due`. | A short findings note added to this plan; I1–I8 confirmed or changed. |
| **IV1 migration + SQL test** | Columns, `invoice_billing_allowed`, patched `stripe_apply_subscription`, validity rule, **the §3a limits** (`invoice_first_payment_pending`, seat rule, company key and VAT uniqueness, 3-day grace, operator alerts), operator functions, sweep seeds, guardrails. | `db:check` green incl. new test with deliberate breaks tried. |
| **IV2 API** | Gateway methods (real + fake), snapshot mapping, `POST /billing/invoice-subscription` (VAT verified with Stripe first, duplicate company refused), reporting keys, write-out integrations and bulk exports refused while `invoice_first_payment_pending` (`403 payable_first`), overview fields, e2e with the fake gateway and real signature verification, tenancy sweep. | `api:test` and `api:test:e2e` green. |
| **IV3 frontend** | Route choice, billing details form, subscription page and banner, wizard summary/review wording; tests; journey step (fake Stripe gateway in `scripts/journey/stack.cjs` learns send-invoice: subscription created, invoice open, then marked paid and, separately, overdue). | `npm test`, lint, build, journey green. |
| **IVX exit check** | Live guardrails + advisors, sandbox end-to-end (invoice emailed, paid by test bank transfer, overdue then locked, paid then unlocked), docs (`stripe-setup.md` §5 invoice case, CLAUDE.md), exit note. | Written down with what was and was not exercised. |

Order of work: IV0 first (it can change the design), then IV1 → IV2 → IV3 → IVX. A migration must be applied live before the API is pushed (the API selects the new columns).

## 7. Out of scope (first version)
Custom payment terms per customer in the UI, credit notes and refunds screens, purchase-order approval workflows, statements, payment by direct debit (BACS Direct Debit is a separate Stripe payment method with its own mandate step and is a better long-term answer for monthly customers), multiple currencies, switching a running subscription between card and invoice, our own overdue emails (Stripe sends them).

## 8. Risks
- **Free use before paying** (I1/I4): now up to 14 + 3 days, on the seats of one invoice, with no way to take data out, one organisation per company, and operators told (I9, §3a). If abuse still appears: free-mail refusal, pay-first access, a minimum first-invoice amount.
- **Stripe dashboard settings are outside the code** and silently change behaviour (unpaid-invoice handling, reminder emails). They are written into `stripe-setup.md` and checked in IVX.
- **Tax:** a wrong or missing address/VAT number produces wrong VAT on an invoice that cannot be edited once finalised; the form validates address completeness and the tax id with Stripe at entry.
- **Bank transfer reconciliation** is Stripe's (customer balance); a payment that arrives without the invoice reference can sit unapplied. Stripe handles most cases automatically; the rest is a manual Stripe-dashboard task for the owner and is not built here.
