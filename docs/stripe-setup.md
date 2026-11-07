# Stripe set-up (test mode first)

What you do once, outside the code. Nothing here needs a deploy to start: the API runs without Stripe (billing routes answer `503 billing_unavailable`).

## 1. Stripe account
1. Create a Stripe account (or use an existing one) and stay in **test mode** (toggle top-right).
2. **Settings → Tax:** turn on **Stripe Tax**, add your business address and (when you have one) your UK VAT registration. Prices in Fortress QMS are **excluding VAT**; Checkout and invoices add it from the customer's billing address.
3. **Settings → Billing → Customer portal** (test mode): enable it, and choose
   - Customers can **update payment methods**, **update billing information** (incl. tax IDs) and **view invoice history**: on.
   - **Cancel subscriptions: on, "at end of billing period"** (cancellation only ever takes effect at period end).
   - **Update subscriptions** (switch plan / change quantity): **off**: seats are changed inside Fortress QMS, where the seat rules are enforced.
4. **Developers → API keys:** copy the **secret key** (`sk_test_…`). A restricted key also works if it can write Customers, Checkout Sessions, Subscriptions, Billing portal sessions, Invoices (read), Products and Prices.

## 2. Products and prices (one command)
```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --dry-run   # see what it would do
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs             # creates what is missing
```
It creates three products and six GBP prices (£5 / £10 / £25 per seat per month; annual = 10 ×), finds them again by lookup key on the next run, and prints the SQL that records the Stripe price ids. Run that SQL against the matching Supabase project (ask me and I will run it when you say so). Repeat later with a live key for live mode.

## 3. Webhook endpoint
**Developers → Webhooks → Add endpoint**
- URL: `https://<your API host>/api/v1/stripe/webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end`, `invoice.created`, `.finalized`, `.updated`, `.paid`, `.payment_succeeded`, `.payment_failed`, `.voided`, `.marked_uncollectible`
- Copy the endpoint's **signing secret** (`whsec_…`).

For local work: `stripe listen --forward-to localhost:3001/api/v1/stripe/webhook` prints a signing secret for that session.

## 4. Environment variables (API project on Vercel, and `api/.env` locally)
| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the secret key from step 1 |
| `STRIPE_WEBHOOK_SECRET` | the signing secret from step 3 |
| `APP_BASE_URL` | the web app's address, e.g. `https://qms-web-dev.vercel.app` (Stripe's return links) |
| `CRON_SECRET` | any long random string (20+ characters): protects the scheduled jobs below |

Never put these in the web app (`VITE_…`) or in source control. The API refuses a key that does not look like a Stripe secret key and never prints it.

## 5. Try it
Sign up, start an organisation, choose seats on **Plan & seats**, pay with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC). Failure cases: `4000 0000 0000 0341` (attaches, then the first charge fails: past due), `4000 0000 0000 9995` (insufficient funds).
The operator can switch the billing gate on for new organisations only after this works end to end: `update public.platform_settings set value = 'true'::jsonb where key = 'billing_gate_enabled';`

## How it behaves (for support)
- Stripe is the source of truth for status, quantities and invoices; the app re-reads from Stripe on every event and on the success page, so a lost or late webhook is repaired by the next event or by opening Subscription & billing. Every event id is recorded once in `stripe_events` (status, attempts, error).
- A trial lasts 14 days with a card on file. Payment failure → `past_due`, access continues for the grace period (7 days), then the organisation is locked to billing until it is paid. Cancellation (Portal) takes effect at the end of the paid period.
- An owner must always hold a Controller seat while the subscription is valid; the database refuses changes that would break that.

## Scheduled jobs
`api/vercel.json` runs two jobs daily, **on the production deployment only** (Vercel does not run crons on previews). On the dev API, call them yourself:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<api>/api/v1/internal/cron/reconcile"                  # re-reads Stripe subscriptions not synced for an hour
curl -H "Authorization: Bearer $CRON_SECRET" "https://<api>/api/v1/internal/cron/abandoned-setups"           # DRY RUN: lists what would be archived
curl -H "Authorization: Bearer $CRON_SECRET" "https://<api>/api/v1/internal/cron/abandoned-setups?dryRun=false"   # really archives
```
Archiving only ever touches organisations that must have a subscription and never got one within 14 days, or whose subscription ended over 90 days ago. To undo: `update public.organisations set status = 'active', archived_at = null, archived_reason = null where id = '<id>';`
