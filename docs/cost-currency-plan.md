# Costs in more than one currency — plan

Status: **draft for agreement (nothing built).** Decisions CU1–CU4 were agreed in conversation on 2026-11-20; CU5–CU8 are proposed defaults; §10 lists what still needs an answer.

## 1. What exists today (inspected 2026-11-20)

- `ncr_costs` is the only place money is recorded. A line has `currency`, `amount` (= `quantity × unit_cost`, worked out by the database), VAT fields, and `exchange_rate`, `net_base`, `gross_base`, `base_currency`.
- **The rate is typed in by hand** (default 1). Nothing says where it came from, which day it is for, or whether it is an estimate.
- `base_currency` on a line is the **organisation's** base currency. `sites.currency` only pre-fills a new line; it is never used for reporting.
- The organisation currency cannot change once any cost exists (`app.organisation_currency_locked`, QM014).
- Consumers of the converted figures: `api/src/ncr/ncr-records.service.ts` (the tracker totals), `ncr.service.ts` (register total cost), `ncr-dashboard.ts` (**gross_base**, VAT included), the workflow fact `total_cost` (**net_base**), and the NC page (`NcrCosts.jsx`, `CostForm.jsx`, `lib/costs.js`).
- Cost types already include `customer_charge` and `supplier_recovery`, but every line is summed as a positive cost (see §10, Q2).
- **Frankfurter** (`https://api.frankfurter.dev/v1/{date}?base=GBP&symbols=USD,EUR`) was called from this environment: no key, historical European Central Bank reference rates, a weekend date answers with the last business day and says which date it used. It publishes about 30 currencies (AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR). **AED, SAR and other currencies have no automatic rate.** The project is open source, so a self-hosted copy is possible later (`FRANKFURTER_URL`).

## 2. Agreed decisions

| | Decision |
|---|---|
| CU1 | **"Base" means the site's base currency.** Each cost is converted into the currency of its NC's site (`sites.currency`) and also into the organisation base currency. A site dashboard is in the site currency; the "all sites" view is in the organisation currency. Both are stored on the line, so nothing is recalculated when a rate moves. |
| CU2 | The NC cost tracker shows **one headline total in the site currency** (marked Estimated / Actual / Mixed) and under it **the original amounts grouped by currency** (for example €1,200 + $300). When the organisation currency differs from the site's, one small extra line shows it. |
| CU3 | **Override**: a person may type either the rate they actually got **or** the converted amount from the invoice or bank statement (the rate is then worked out). The line moves from Estimated to Actual, keeps the automatic rate beside it for comparison, takes an optional note, and every change is audited. |
| CU4 | **No rate available** (Frankfurter down, or a currency it does not publish): the line saves as **Rate needed**, is left out of totals and shown with a warning until a rate arrives or is entered. A background step retries supported currencies. Recording a cost is never blocked. |

## 3. Proposed defaults (change any of these)

- **CU5 — which day's rate.** The rate for the line's `incurred_on` (a weekend or holiday uses the last business day, and the line says so). A date today or later uses the latest rate. The rate is **frozen when the line is saved**; it never drifts afterwards. **Refresh rate** on an *Estimated* line fetches it again; an *Actual* line is never refreshed.
- **CU6 — who may override.** The same right as editing a cost (`ncr.update` at the NC's site, NC still editable). No new permission.
- **CU7 — editing a line afterwards.** Changing the amount, quantity or VAT keeps the rate. Changing the **currency or the incurred date drops an override** (the rate no longer fits) and the line goes back to an automatic estimate, with a notice.
- **CU8 — the amount an override applies to.** When you type a converted amount it is the converted value of **the amount you entered** (gross if you entered it VAT-inclusive, net otherwise), so VAT is never guessed.

## 4. Data model (migration `…_cost_currency.sql`)

**`sites.currency`** becomes required (it already defaults from the organisation when a site is made). It cannot change once an NC at that site has a cost line (QM014, the same rule as the organisation currency).

**`exchange_rates`** — a global reference cache, not tenant data (listed as a reviewed global table in the guardrails): `requested_on`, `rate_date`, `base`, `quote`, `rate`, `source`, `fetched_at`; unique on (`requested_on`, `base`, `quote`). Readable by signed-in people, **written only by the API login** (`app.system_store_exchange_rates`). It also records pairs Frankfurter said it does not publish, so they are not asked again.

**`ncr_costs`** — existing columns stay and change meaning only as follows: `base_currency`, `exchange_rate`, `net_base`, `gross_base` are now the **site** conversion. New columns:

| Column | Meaning |
|---|---|
| `org_currency`, `org_rate`, `net_org`, `gross_org` | The organisation-currency figures, for the all-sites view and anything that adds up across sites |
| `rate_status` | `base` (same currency, rate 1), `estimated`, `actual`, `needed` |
| `rate_source` | `none`, `frankfurter`, `manual` |
| `rate_date`, `rate_fetched_at` | Which day's rate, and when it was fetched |
| `estimated_rate` | The automatic rate, kept when the line is overridden |
| `override_kind`, `override_note`, `overridden_at/by` | `rate` or `amount`, why, and who |

**Writes.** The rate and its provenance columns leave the column-level UPDATE grant. They are written only by functions:

- the cost trigger itself, which looks the pair up in `exchange_rates` when a line is saved and sets `estimated` (found), `needed` (not found) or `base` (same currency);
- `app.system_fill_cost_rates(...)` (API login only): after the API has fetched and cached a missing rate it fills the waiting lines;
- `app.override_cost_rate(cost, kind, value, note)` (people, `ncr.update`): validates, sets `actual`, keeps `estimated_rate`;
- `app.refresh_cost_rate(cost)` (people): only for an *Estimated* line, takes the cached rate again.

The browser can therefore no longer submit a rate on create or update; `exchangeRate` leaves the cost bodies. The database stays the one place that does the arithmetic (`round(net × rate, 2)`), so the preview and the saved line cannot disagree. An overridden line's organisation figure is derived from its site figure through the cached site→organisation rate, so consolidated totals follow the actual cost.

**Existing lines.** Their rate was typed in, so same-currency lines become `base` and foreign ones become `actual` / `manual` (a person chose that rate). `net_org := net_base`, `org_rate := 1`, because their base **was** the organisation currency. Sites whose currency differs from the organisation's are listed in a **restate** report (dry run first, like the production backfill): restating converts those lines into the site currency with rates for their `incurred_on` and marks them estimated. Until then the site dashboard warns that some lines are not in the site currency and leaves them out. (The live data is test data, so this is expected to be small.)

## 5. API (`api/src/currency/` and the NC cost routes)

- **`ExchangeRateService`**: the only code that talks to Frankfurter. One fixed host (no user-supplied address), a 4 second timeout and one retry, one call per line asking for the site and organisation currencies together, results written to the cache. **A failure never fails the request**: the line stays `needed`. Environment `FRANKFURTER_URL` (default `https://api.frankfurter.dev`). Tests inject a fake; **no test may reach the network**.
- **Cost routes**: create and update take no rate. After the insert the service fetches any missing pair and calls `system_fill_cost_rates` in the same request, so the answer already carries the estimate in the normal case. New routes: `POST /ncr-costs/{id}/rate {kind: "rate"|"amount", value, note?}`, `POST /ncr-costs/{id}/refresh-rate`, `GET /exchange-rates/preview?from&to&date` (what the form shows before saving; nothing stored).
- **Totals** (`GET /ncrs/{id}/costs`): `{ siteCurrency, orgCurrency, net, gross (site), netOrg, grossOrg, byCurrency: [{currency, amount, lines}], status: {estimated, actual, needed}, mixed }`; lines carry the rate, its date, status, source and the estimated rate.
- **Dashboard** (`/ncr-dashboard`): a `siteId` filter. One site → site currency (`net_base`); all sites → organisation currency (`net_org`). The answer carries `currency`. A person limited to one site gets that site automatically. Lines with `needed` are excluded and counted in `unconverted`.
- **Register** total cost per row in the NC's own site currency, sorted by the organisation-currency value so mixed sites sort correctly.
- **Workflow fact** `total_cost` uses the organisation-currency net figure (a rule's threshold is one number across sites) and says so in the rule builder.
- **Worker step `exchange-rates`**: retry `needed` lines for supported currencies; give up (leave `needed`, stop retrying) for a pair marked unsupported.
- The organisation-currency lock now also covers sites (QM014).

## 6. Screens

- **Cost dialog**: currency chosen as today; the exchange-rate box goes. Once currency and date are set it shows the automatic rate and its date from the preview ("1 EUR = 0.8355 GBP, ECB 13 Nov"), or "No automatic rate for AED — it will be marked *Rate needed*". Saving never needs a rate.
- **Tracker** (`NcrCosts.jsx`): headline total in the site currency with an Estimated / Actual / Mixed chip, the per-currency breakdown, the extra organisation-currency line when it differs, a warning and a link for lines needing a rate. Per line: Amount, Rate (with its date and a chip), Converted net and gross.
- **Row menu**: **Set actual rate…** (rate *or* converted amount, a note, and the automatic rate and the difference shown for comparison), **Refresh rate** (estimated only), **Use automatic rate** (drops an override).
- **NC dashboard and the home/review gatherings**: a site filter, the currency in every figure's formatting, a note when lines are waiting for a rate.
- **Settings → Organisation → Sites**: the site dialog explains that the currency becomes locked once costs exist.

## 7. Slices

1. **CU-A — database.** Migration, trigger rewrite, functions, backfill and restate function, extended currency lock, `exchange_rates`, guardrails and both sweep seeds. SQL tests: same-currency, estimated, needed, weekend date, override by rate and by amount (VAT inclusive / exclusive / none), refresh rules, an edit that drops an override, rounding, every write path refused for the browser, cross-organisation isolation, backfill and restate on a fixture. Mutants for the arithmetic and the frozen rules.
2. **CU-B — API.** Service and cache, routes, totals shape, dashboard and register, workflow fact, worker step, restate endpoint (dry run default). E2E with a fake Frankfurter: found, down, unsupported currency, weekend, retry from the worker.
3. **CU-C — screens.** Dialog, tracker, row menu, dashboard filter and currency, site dialog notice. Tests for the totals, the chips and the override dialog.
4. **CU-D — exit.** Live guardrails and advisors, a browser journey step (foreign-currency cost, estimate, override, totals), documentation, the exit note.

Each slice is complete and tested on its own. Pushing the API before the migration breaks the cost endpoints (they select the new columns).

## 8. Security and integrity

- Rates are reference data; people never write them. Only the API login writes `exchange_rates`, and the lines' rate columns change only through the functions above.
- An override is an audited, attributed change on the line (`audit_changes` already covers `ncr_costs`) and the earlier automatic rate is kept.
- Frankfurter sees only a currency pair and a date, never an organisation, person or amount.
- Rates are validated as positive, finite and below a sane ceiling; amounts keep the existing `< 1e12` limit.
- The outbound call uses a fixed host and no redirects; a hostile or broken answer fails the lookup and leaves the line `needed`.

## 9. Not in scope

Automatic revaluation, month-end or invoice-date rates, per-site rate sources, exchange gains and losses, VAT per currency, a rate history screen, money outside NC costs (nothing else records money today; the cache and `app.convert_amount` are built so calibration, SCAR or 8D costs can reuse them).

## 10. Open questions

1. **Net or gross on dashboards.** The NC dashboard adds `gross_base` (VAT included) while the workflow fact uses net. Cost of poor quality is normally ex-VAT. *Proposed: dashboards, the register and workflow facts all use **net**; gross stays on the tracker.*
2. **Recoveries and charges.** `supplier_recovery` and `customer_charge` are summed as positive costs today. *Proposed: treat them as credits that reduce the net cost (shown negative), or leave as they are and say so. Needs your call; it changes totals.*
3. **Restating existing lines.** Any site whose currency already differs from the organisation's has old lines in the organisation currency. *Proposed: dry-run report, then one confirmed restate with estimated rates for the original dates.*
4. **Currencies Frankfurter does not cover.** They will always be Rate needed until someone enters a rate. *Proposed: accept this; a self-hosted or second rate source can be added later behind the same service.*
