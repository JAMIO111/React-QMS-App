# Importing NC cost lines through the connectors — plan

Status: **IN-NC, IC1 (the database), IC2 (the API) and IC3 (the screens) and IC4 (the exit check, `docs/cost-import-exit-report.md`) built: the cost import is complete.** Decisions CI-D1, D2 and D4–D8 (§4) and CI-D9 to CI-D13 (§7) accepted by the owner 2026-11-22, all as recommended; **CI-D10 replaces CI-D3**: the owner wants to carry the
source's status over when importing NCs, so many NCs will arrive closed or cancelled. Written 2026-11-22.

## 1. What was asked

Cost lines on non-conformances can only be typed in today. Bring them in through the connectors (file, REST API, connector agent) like the other record kinds.
The lines **link to their non-conformance by the NC's id** (the id the source system uses), and the question was what happens to currency conversion when the
imported lines are all in different currencies.

## 2. What exists today (inspected)

- **One cost table:** `ncr_costs` (see `docs/cost-currency-plan.md`). Nothing else holds costs. It is **not importable**: the import catalogue has no cost fields and
  `ncr_costs` is not one of the kinds in `app.integration_entity_types()`.
- **The database works everything out.** A line is entered as cost type, description, incurred date, currency, VAT treatment and rate, quantity and unit cost.
  The trigger `app.ncr_cost_amounts` works out `amount = round(quantity × unit cost, 2)`, net, VAT and gross, and **the rate**: nobody types one.
- **Rates** come from `public.exchange_rates` (a cache of published rates, written only by the API login). The trigger looks the pair up **for the incurred date**
  (never later than today; a weekend or holiday carries the last business day's rate, `rate_date` says which) **twice**: line currency → the NC's **site
  currency** ("base", fixed when the line is made; the organisation's currency when the NC has no site) and line currency → the **organisation currency** (for
  totals across sites). `rate_status` is `base` (same currency), `estimated` (published), `actual` (a person stated it) or `needed` (no rate yet).
  A `needed` line has no net base or organisation figure, so it **adds to no total** until a rate arrives.
- **Filling waiting lines:** `ExchangeRateService.settle` fetches what `app.system_cost_rates_needed` lists (bounded batches), stores it and calls
  `app.system_fill_cost_rates`. It runs after a cost is saved through the API and as the worker step `exchange-rates`. The source is Frankfurter (the ECB's
  reference rates, roughly thirty major currencies); a pair it does not publish stays `needed`.
- **Credits** (`supplier_recovery`, `customer_charge`) carry `cost_sign = -1`; every total multiplies net by it. `amount` itself cannot be negative.
- **Who may write:** the table's insert policy is `ncr.update` at the NC's site, and the trigger refuses a closed, cancelled or deleted NC.
- **How an import works** (the pattern to follow): a catalogue entry (`catalogue.ts`), a column map that classifies every column (`columns.ts`, drift test), an
  `app.import_<kind>` function called by `app.system_import_record` **as the requester** (their claims are set, so RLS, triggers and the audit actor apply), a write
  permission in `app.integration_may_write`, a fixed write mode, and a reference kind for links to other records (D10: the source id from an earlier import through
  the same connection, or the Fortress code). Non-conformances are importable (always add-only, as drafts); goods receipts and legacy calibrations are the closest
  precedents for a child record that is only ever added. `legacy_calibration_import` shows how to patch the shared import functions safely (`pg_temp.patch`).

## 3. Design

### 3.1 The new kind: "NC cost lines" (`ncr_cost`)

One source row = one cost line. Catalogue fields:

| Field | Becomes | Notes |
|---|---|---|
| **Non-conformance** (required) | `nonconformance_id` | a link, see §3.2 |
| **Cost type** (required) | `cost_type` | one of the 15 types; the catalogue reads the allowed values from the table's CHECK, so the mapping page offers them and the `map` step translates the source's words |
| Description | `description` | ≤ 500 |
| **Incurred on** (required) | `incurred_on` | a date; **required** (not defaulted to today), because the date decides the rate; a future date is capped at today for the rate |
| **Currency** (required) | `currency` | three letters, any case ("eur" works); anything else rejects the row |
| **Unit cost** (required) | `unit_cost` | ≥ 0 |
| Quantity | `quantity` | > 0, decimals allowed; empty = 1, so a source that has only a total puts it in Unit cost |
| VAT treatment | `vat_treatment` | none / inclusive / exclusive; empty = none |
| VAT rate | `vat_rate` | percent in the file (as the cost form shows it); empty with a treatment = the organisation's rate |
| Value in the site currency (optional) | see §3.3 | what the source booked, to keep it instead of a published rate |

Rules, all inherited from the table and trigger so a person and an import cannot disagree: the NC must be open (draft up to awaiting closure), not closed,
cancelled or deleted; the person needs `ncr.update` at the NC's site; amount is ≥ 0; the organisation and site currencies are read from the NC.

### 3.2 Linking by the NC's id

A new reference kind `nonconformance` with the two matches every other link has (decision D10):

- **by the source's id** (`match: source`): the id the source system uses for that NC, found through the map of an **earlier non-conformance import through the same
  connection** (`integration_external_records`, kind `nonconformance`). This is "link by NC id". Import the NCs first, then their costs, as the machines-then-NCs
  test already does.
- **by Fortress reference** (`match: code`): `SNC-26-0011`, ignoring case, for NCs made by hand or imported elsewhere.

An unresolved or ambiguous link rejects that row with the reason, in the preview too. NCs imported by this connection arrive as **drafts**, which accept costs.
The list of allowed values (the "See the list" dialog) learns this kind: reference, title and stage as the hint, searchable and paged.

### 3.3 Currencies: what happens when every line is in a different currency

**Each line keeps its own currency; nothing is converted at the file level and no rate is read from the file.** Every line is converted by the same trigger a typed
line goes through, on its own incurred date:

- line currency → the NC's site currency (**base**) and line currency → the organisation currency, both at the published rate for the incurred date;
- the **rate is fixed when the line is written**: a re-import writes nothing, a later rate change never moves it, a person can still state the real rate on a
  line afterwards (the existing rate dialog);
- a line already in the site's currency is `base` (rate 1); a line in a currency the source of rates does not publish is `needed` and adds to no total;
- a line whose rate is not in the cache yet **still imports**, as `needed`, and is filled when the rate arrives. Nothing is refused for want of a rate.

Example (illustrative rates, one NC at a site whose currency and the organisation's are GBP):

| Line | As imported | Rate used | In GBP | Status |
|---|---|---|---|---|
| Scrap | 1,000.00 EUR on Mon 3 Mar | EUR→GBP for 3 Mar | at that rate | Estimated |
| Freight | 500.00 USD on Mon 3 Mar | USD→GBP for 3 Mar | at that rate | Estimated |
| Sorting | 12,000.00 SEK on Sun 9 Mar | SEK→GBP for the Friday before | at that rate | Estimated (rate date shows Fri 7 Mar) |
| Labour | 200.00 GBP | none | 200.00 | Base |
| Tooling | 80.00 in a currency not published | none | not counted yet | Waiting for a rate |

The NC's cost total is shown in the site's currency (Estimated, Actual or Mixed), with the organisation-currency line and spend by currency beside it, exactly as
for typed lines. If the site were in EUR and the organisation in GBP, every line would be converted to **both** EUR and GBP separately.

**Getting the rates in time for an import.** Today a line without a cached rate is filled afterwards by `settle`. A large historical import (many dates × many
currencies) would leave most lines `needed` at first and fill them over several worker passes. So:

1. **Before the first rows of a run are applied**, the engine collects the distinct (date, currency) pairs the staged rows need and asks `ExchangeRateService` for
   the missing ones within a time budget (the same fetch and store the preview uses). Most lines then land with their rate.
2. **At the end of the run** it settles once more for the organisation, and the worker's `exchange-rates` step finishes the rest (a bounded batch per pass).
3. **The preview says it before anyone imports:** "412 lines: EUR 230, USD 150, SEK 32; all have a published rate" or "14 lines in XYZ have no published rate and
   will wait". The run page gains a **Waiting for a rate** tile (the lines of this run still `needed`) with a link to the NC.
4. One caution that already exists: **a site's currency is locked once lines are stated in it** (and an NC with costs cannot move to a site in another
   currency). Importing costs therefore fixes the site currencies in use; correct a wrong site currency before the import, not after (a restate exists, §2).

**Optional: keep the source's own booked value.** Many ERPs book a converted value on the posting. The optional field *Value in the site currency* (what the source
booked for the whole line) is applied through the same mechanism as a person stating the converted amount (`app.override_cost_rate`, kind `amount`): the line is
**Actual**, the published rate is kept beside it as the estimate, and the note says it came from the import. Without the field, the published rate is used.
A line already in the site currency ignores it.

### 3.4 Behaviour of the kind

- **Always add-only, never matched** (like goods receipts): a source line is imported once, keyed by the **source's line id** (the key column); a second import of the
  same line writes nothing. A changed amount in the source is not applied (a cost posting is not edited; a correction is a new line, a credit is a recovery type).
  A line a person deleted in Fortress is not brought back by a re-import.
- **Closed, cancelled or deleted NC:** the row is rejected with the table's own message ("reopen it to make changes"); fix it and use *Retry failed rows*.
- **Negative amount:** rejected, with the advice to import it as a supplier recovery or customer charge (the types that count as credits).
- **Records that disappear:** does not apply (like NCs and receipts); schedules are not offered (a file or API import is run when needed; a scheduled API import
  of costs would add new lines each run and is allowed, because it is add-only and idempotent).
- **Permissions:** the person importing needs `integrations.run`, the Controller seat that every integrations right needs, and `ncr.update` at each NC's site; a
  row for an NC they may not change is rejected like any other.
- **Audit and notices:** the audit trigger records each line with the import as the actor (the initiating person); nothing is notified and no workflow starts
  from a cost line (workflow facts read the total only when an NC event happens).
- **Locks:** not lockable (add-only).

## 4. Decisions proposed

| | Decision | Recommendation |
|---|---|---|
| CI-D1 | Add-only, or also update lines whose amount changed in the source | **Add-only.** A posted cost is not edited; corrections are new lines. Updating can follow if a source really edits lines |
| CI-D2 | Link by the source's NC id (earlier NC import, same connection) and by Fortress reference | **Both**, as every other link (D10) |
| CI-D3 | Costs on a closed or cancelled NC | **Reopened, see §7.** Rejected for NCs made in Fortress; for NCs an import brought in, an import setting (off by default) lets cost lines be added to them |
| CI-D4 | Negative amounts | **Reject**, pointing to the recovery and charge types |
| CI-D5 | Offer the source's booked value in the site currency | **Yes, optional**; becomes Actual. Off unless mapped |
| CI-D6 | Fetch the needed rates before applying | **Yes** (§3.3): otherwise a big import lands mostly "waiting" |
| CI-D7 | Incurred date and currency required | **Yes**: the date decides the rate; no silent "today" for an old line |
| CI-D8 | VAT percent in the file, organisation rate when a treatment is given without one | **Yes**, as the cost form does |

## 5. Slices

- **IC1 — database.** Migration (the kind added to `app.integration_entity_types()`, `app.import_ncr_cost`, the reference lookup and allowed-values for
  `nonconformance`, `app.integration_may_write`, add-only and no-missing-records, the booked-value path, `app.integration_cost_rate_summary(run)`), all shared import
  functions patched from their live definitions (`pg_temp.patch`). SQL test with deliberate breaks: link by source id and by reference, ambiguous / unknown NC,
  closed NC, negative amount, unpublished currency (line imports as needed, then fills), booked value, idempotent re-import, a site without `ncr.update`, cross-organisation.
- **IC2 — API.** Catalogue entry and `columns.ts` (every `ncr_costs` column classified, the drift test), `RefKind` `nonconformance`, importer registration,
  the pre-warm and end-of-run settle in the sync engine, the preview's currency summary, run answers carry the waiting count. e2e with the fake rate source (no test
  reaches the network): all-different-currencies file, unpublished currency, weekend date, re-import, mixed matching.
- **IC3 — screens.** Import wizard tile "NC cost lines", the link field's Match by (source id / reference), the currency summary in the mapping step, "Waiting for a
  rate" on the run page, the allowed-values dialog for NCs; import labels and words. Tests.
- **IC4 — exit.** Browser journey step (NCs then costs through the wizard, three currencies, a line waiting for a rate that fills, the NC's totals), live guardrails,
  advisors, `CLAUDE.md`, an exit note.

## 6. Not built (by design)

Updating existing cost lines from a source; importing cost lines for anything but NCs (8D actions, SCARs, calibrations and production orders have no costs); importing
exchange rates from the source system; a bulk "state the rate" for many lines (one-by-one stays on the NC); a rate cache for dates older than the rate source holds
(those lines stay "waiting" and can be stated by hand).

## 7. Carrying the source's status over when importing NCs (raised 2026-11-22)

**Why it matters for costs.** Today an imported NC is always a draft (`app.import_nonconformance` inserts `stage = 'draft'`), and the table's rules refuse any other stage on a
signed-in person's insert (`nonconformance_rules`: "a new non-conformance starts as draft or open"); the import writes as the requesting person, so those rules apply to it.
If NCs came in closed or cancelled, **every cost line for them would be refused** by `app.assert_ncr_editable` (closed and cancelled NCs are frozen), which is what CI-D3
as first written would also do. So yes: with status carried over, costs must be allowed onto closed and cancelled NCs, **but only the ones an import brought in**.

**Proposed rule for costs (replaces CI-D3).** A new import setting on the cost template, **"Add costs to closed or cancelled NCs this connection imported"**, off by
default. When on, the row is accepted only if the NC has a row in the import map for the same organisation (so it is an imported, historical record), is not deleted,
and the person has `ncr.update` at its site. The check lives in the database: `app.import_ncr_cost` sets a transaction-local flag that `app.assert_ncr_editable` honours
only together with that map check, so no other route can use it. NCs raised in Fortress stay frozen once closed. The line is audited with the import as the actor.
A cancelled NC with costs is unusual, so the preview counts the lines going onto closed and onto cancelled NCs separately.

**What carrying the status over takes on the NC side** (a separate slice before or beside the cost import; found by reading `nonconformance_rules`, the stage-gate trigger
and the opening rules):

1. **Stage field.** The NC catalogue gains **Stage** (the eight stages: draft, open, contained, investigating, dispositioned, awaiting closure, closed, cancelled; the mapping
   page's `map` step translates the source's words). Empty keeps today's behaviour (draft). Closed also takes **Closed on** (a date, from the source; empty = the import day)
   and cancelled takes a **reason** (required by the table; default "Cancelled in <connection name>").
2. **The insert rule.** The import sets a transaction-local flag (set only by `app.import_nonconformance`, like `app.ncr_source_change`) that lets the rules trigger accept those
   stages on insert and stamp `closed_at` from the source. The cumulative stage gates (containment resolved, dispositions approved and covering the quantity) are a
   BEFORE UPDATE trigger and are not involved in an insert, so a historical closed NC with no containment or disposition records is possible, as the grandfathered NCs
   already are. From then on Fortress treats it normally: a reopened NC needs the gates again to close.
3. **The opening rules still apply** to every stage past draft: a **category**, and the party for a customer or supplier source (and the other opening fields). A source
   that lacks them has its row rejected with the reason. Proposed option: **"Category when the source has none"** (a combo of the organisation's categories) on the import
   settings, so old data does not stall; off by default.
4. **No flood.** An NC created open or closed raises `ncr.created` / `ncr.stage_changed` / `ncr.closed` events, which feed notifications and workflow rules ("NC raised",
   "stage changed"). Thousands of historical records must not tell everyone or start rules. Precedent: a legacy calibration raises no event. The historical insert should
   write the audit trail as now but **raise no event and no notice** (to be confirmed against the event and notification code when this slice is built).
5. **Later changes in the source** (an NC closed in the source after the import) are **not** carried: NCs stay add-only and are managed in Fortress after arrival
   (no matching, no updates). A one-off historical load is what this supports. Keeping status in step later is a different, larger decision (field ownership, the gates).

**Decisions to confirm**

| | Decision | Recommendation |
|---|---|---|
| CI-D9 | NC import takes a Stage (and closed date, cancelled reason) from the source | **Yes**, all eight stages allowed, empty = draft |
| CI-D10 | Costs on closed or cancelled NCs | **Only NCs an import brought in**, behind an import setting, off by default (replaces CI-D3) |
| CI-D11 | Rows without a category past draft | **Reject by default**; optional default category on the import settings |
| CI-D12 | Historical stage inserts raise no events or notices | **Yes** |
| CI-D13 | Source status changes after the import | **Not carried**; NCs are add-only |

**IN-NC built 2026-11-22** (migration `20260420100000_nc_import_stage.sql`, not yet applied live; see `CLAUDE.md`). Findings while building it: CI-D11 needs no new setting, because a mapping field's existing "when empty" default does the same job; stages between open and closed also need the right to approve dispositions (they skip what those stages prove), which the plan had not said; and a closed date is compared with the detected date only when the source gave a detected date (without one the table's default is today, not a date anyone gave).

Slice order becomes: **IN-NC** (stage carry-over: migration, catalogue, importer, tests), then IC1–IC4 as in §5, with the cost importer's closed-NC setting added to IC1.


## 8. IC1 built (2026-11-22)

Migration `20260421100000_ncr_cost_import.sql` (not yet applied live; apply it as one script, like the NC stage one; it strips `\r` before matching, so Windows line endings in live definitions are fine). SQL test `supabase/tests/ncr_cost_import.test.sql` (four deliberate breaks caught: the map check, the integration-source check, the permission check, the negative-amount check).
What it holds, and the decisions it settled:
- **`app.import_ncr_cost(org, id, data, connection, on_closed)`** (add only; catalogue keys `nonconformance` (link), `costType`, `description`, `incurredOn`, `currency`, `unitCost`, `quantity`, `vatTreatment`, `vatRate` (percent), `bookedValue`). It checks `ncr.update` at the NC's site itself, because the table's insert rule is not applied inside a definer function. Values are written through the table's own triggers, so amount, VAT and both rates are worked out exactly as for a typed line. A VAT treatment with no rate takes the organisation's; the percent is stored as a fraction rounded to six places.
- **Closed and cancelled NCs (CI-D10):** the template setting is **`costsOnClosed`** (kept on the template version only for this kind; off unless chosen). `app.ncr_cost_import_may_edit(ncr)` is honoured by `app.assert_ncr_editable` only when a transaction-local switch is on AND the source is `integration` AND the NC has a row in the import map AND it is not deleted. A hand-made closed NC stays frozen whatever the setting says; a deleted one is never accepted.
- **Booked value (CI-D5):** applied through `app.override_cost_rate(…, 'amount', …)` so the line is Actual and the published rate is kept as the estimate; ignored when the line is already in the site currency or costs nothing; it also settles a line that had no published rate.
- **Link to the NC (CI-D2):** reference kind `nonconformance`, matched by the source's id (the import map, as for every kind) or by the Fortress reference ignoring case (`app.integration_find_by_code`); the list of allowed values includes NCs (reference, title, stage as the hint) for people who may read NCs.
- **`app.integration_cost_run_summary(run)`** for the preview and the run page: lines, per currency how many have a published rate for their date into the site currency (so will not wait), how many go onto closed and onto cancelled NCs, how many carry a booked value, and how many written lines are still waiting for a rate.
- Shared functions patched (checked text patches): entity types, write permission (`ncr.update`), add-only mode, template and connection settings, no disappearing records, stage matching, reference values and lookup.
- **Not done in IC1 (IC2):** the API catalogue entry and `columns.ts`, the `nonconformance` ref kind in the API, importer registration, the template settings schema carrying `costsOnClosed`, pre-warming and settling exchange rates in the engine, the preview's currency summary endpoint.

## 9. IC2 built (2026-11-22)

API only, no screens yet. One addition to the IC1 migration (still not applied live): `app.system_integration_cost_rates_needed(org, run, owner, limit)` (API login only) lists, for a run's staged lines, the (day, currency) pairs the exchange-rate cache does not answer yet, in the shape `app.system_cost_rates_needed` uses for lines already written; `app.integration_cost_run_summary` now asks the cache once per distinct pair, not once per line.
- **Catalogue and column map:** kind `ncr_cost` ("NC cost lines") in `catalogue.ts` (link `nonconformance` required, `costType`, `description`, `incurredOn` required, `currency` required, `unitCost` required and not below 0, `quantity`, `vatTreatment`, `vatRate` as a percentage, `bookedValue`), `columns.ts` classifies every `ncr_costs` column (VAT rate keeps `ownRules` because the column holds a fraction; `bookedValue` is virtual), new `RefKind` `nonconformance` (matched by the source's id or the Fortress reference), importer registered, add only and no disappearing records (`ADD_ONLY_KINDS`, `EVENT_KINDS`), the drift test lists it as not lockable.
- **Template setting `costsOnClosed`:** accepted by `TemplateSettingsBody`, carried in template versions and in a run's frozen settings (run detail), false unless chosen; only cost templates carry it.
- **Rates before lines (CI-D6):** `SyncEngine.warmRates` runs once per drain when a cost run's rows are staged (preview or full): rounds of `system_integration_cost_rates_needed` → `ExchangeRateService.ensurePairs`, within 60% of the budget (at most 25 s), stopping when nothing more is missing or the source gives nothing back (**an unreachable source never fails the run**: the lines import as waiting). When a full run finishes the engine settles once more (`settle`, 5 s); the worker's `exchange-rates` step finishes the rest.
- **Run detail** carries `costs` for a cost import (lines, per currency `lines` / `withRate` / `waiting`, `onClosed`, `onCancelled`, `booked`, `waitingNow`), from `app.integration_cost_run_summary`.
- Tests: `api/test/integration-cost-import.e2e-spec.ts` (fake rate source; the NCs first, lines in six currencies on their own dates incl. a Sunday, the pre-fetch proved by the lines never being updated (a mutant that removes it is caught), re-import writes nothing, a waiting line filled when its rate arrives, a source that is down, link by reference, negative cost and unknown NC rejected in the preview, a credit as a recovery, booked value Actual, closed and cancelled NCs only with the template setting and never a hand-made one, another organisation sees nothing), `integration-catalogue-drift.e2e-spec.ts`.

## 10. IC3 built (2026-11-22)

Screens only, no migration. The migration of IC1 is applied live (2026-11-22, checked: functions, patches and privileges as intended).
- **Tile and words:** "NC cost lines" appears with the other kinds in the import wizard (the tiles come from the API's entity list, so it needed no new tile code; `ENTITY_LABELS`, `ENTITY_DESCRIPTIONS`, `recordPath` in `lib/integrations.js`). It is in `ADD_ONLY_KINDS` (`lib/importTemplates.js`), so the "What importing may do" card shows it fixed as add only.
- **Template setting:** `templateSettings` keeps `costsOnClosed` for a cost template only, so a changed choice counts as a change to the template and is saved as the next version. `TemplateSettingsCard` has the switch **Allow costs on closed or cancelled non-conformances** with the rule beside it (an import-made NC only; one made by hand stays closed; a deleted one never).
- **Match by:** the link to the non-conformance has the same Match by choice as every other link, with its own words (`matchHint`): the Fortress reference such as SNC-26-0011, or the id the NC had in the source from importing the NCs through this connection first.
- **Currencies:** the mapping step has a notice for cost lines (`CostCurrencyNotice`): nothing is converted in the file, each line is converted on its own incurred date, a currency with no published rate still imports and fills in later. The per-currency figures themselves come from the run, not the mapping step (the template preview has no rates to read), so they are on the **run page** (`CostRunCard`, from `run.costs`, for a preview and a finished import): a table of currencies with lines, lines with a rate and lines waiting; "N lines will wait for a rate"; after an import "N imported lines are still waiting"; closed and cancelled counts with the template rule; the number carrying the source's booked value.
- **Allowed values:** the dialog lists non-conformances (reference, title, stage) and marks closed or cancelled ones "closed or cancelled" instead of "inactive" (`ReferenceValues.jsx`).
- Tests `src/components/integrations/CostImport.test.jsx` (17), `npm test` 1,993 passing, lint 0 errors, build passes. **Not browser-checked yet** (IC4: the journey step).

## 11. IC4 built (2026-11-23)

Journey step `costImport()` (`scripts/journey/journey.cjs`), live checks and the exit report `docs/cost-import-exit-report.md`. The whole journey passes. Not built: updating a posted line from the source, the currency figures in the mapping step.

## 12. A line with no date (raised and built 2026-11-23, decision CI-D14)

**Asked:** a cost line whose date is empty, or whose file has no date column mapped, should optionally take the non-conformance's date.

**Decision CI-D14 (two choices only).** A cost template has a setting **When a line has no date**:
- **Refuse the line** (`reject`, the default and what always happened): the row is rejected, because the date decides the exchange rate.
- **Use the date the non-conformance was detected** (`nc_detected`): the line is dated that day and takes that day's rate (a detected date in the future counts as today, as any future line does).

The import day is deliberately **not** offered: it would date a historical cost today and convert it at today's rate, silently. A line that has its own date always keeps it.

**What it touches.** Migration `20260422100000_ncr_cost_missing_date.sql` (**applied live: not yet**) replaces `app.import_ncr_cost` (a sixth argument), patches `app.system_import_record` and `app.integration_template_settings`, adds `app.system_integration_run_settings` (API login only: the sync engine reads the run's frozen settings through it) and replaces `app.integration_cost_run_summary` (now `datedFromNc`) and `app.system_integration_cost_rates_needed` (the rates for the detected day are fetched before the lines are written). API: `catalogueForSettings` (`core/catalogue.ts`) makes `incurredOn` optional when the setting is on, used when a template is saved, previewed and by the engine; `TemplateSettingsBody`, template versions, run settings and `CostRunSummary` carry `missingDate` / `datedFromNc`; the preview endpoint takes `settings`. UI: a combo on the template settings card, the mapping step treats the date as optional while it is on (`fieldsForSettings`), the run page says how many lines took the non-conformance's date (`CostRunCard`).

**The catch, said in the UI:** a non-conformance imported without a "Detected on" date was given the import day as its detected date, so its costs would take that day too. Map "Detected on" when importing the non-conformances if the dates matter.
