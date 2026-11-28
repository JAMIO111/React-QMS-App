# Non-conformance module audit (28 Nov 2026)

Same kind of audit as the calibration one (`docs/audit-2026-11.md`, then the gauge and calibration rule fixes).
Three read-only reviews (database rules, API, screens) read the code and the tests; nothing was run against the live
project and **no code was changed**. This file is the combined list, most serious first.

**How sure each finding is.** *Checked* = I read the lines myself after the review reported it. *Reported* = the
reviewer read the code and quoted it, I have not re-read it. Nothing here has been reproduced by running it, so a
fix should start with a failing test that shows the problem.

## High

| ID | What | Where | Status |
|---|---|---|---|
| UI-1 | **The NC form is wiped when anything else changes the NC.** The form is reset from the server copy whenever the detail changes. Adding a cost line, linking an 8D, saving a custom value or changing the source refreshes the NC (its total cost, 8D count or custom values differ), and a colleague's save does the same when the tab regains focus. Everything typed and not yet saved disappears with no message. | `NcrPage.jsx:147-148` (`original` memo, `reset(original)`) | Checked |
| UI-2 | **A refused save wipes everything typed.** The save is a flat PATCH, so the generic optimistic update patches the cached NC, and a refusal rolls it back; the form resets on both. Id fields (category, part, site) are not keys of the cached copy, so they flicker back to the old value even when the save works. "Cancel" in the edit-conflict dialog says typing is kept, but it is already gone. | `NcrPage.jsx:203-205`, `useNcr.js:154`, `lib/optimistic.js` | Reported |
| API-1 | **The dashboard trend's "total" counts sources, not NCs.** `count(r.*)` runs over rows already grouped by (week, source), so three internal NCs in one week show as 1. The bars use the per-source counts, which are right, so the table and the bars disagree. | `ncr-dashboard.ts:135` | Checked |
| DB-1 | **A cancelled NC can be reopened without the opening rules.** Reopening a cancelled NC returns before `assert_ncr_openable`. *Correction after fixing it:* the reviewer thought a draft could be cancelled with no fields, but cancelling a draft already runs the opening rules, so the real exposure is an NC that **arrived already cancelled** (a history import, which is exempt on purpose, or a legacy copy). Separately, `customer_id` / `supplier_id` can be set to null on an open customer or supplier NC (only `change_ncr_source` re-checks the party). | `20251218100000_ncr_category_source.sql:170-200` | Checked; **fixed, see below** |
| DB-2 | **"One live NC per reading / finding / receipt line" holds only at the moment of linking.** Two people raising on the same failed readings at once both pass the check (no lock). Reopening a cancelled NC, or restoring a deleted one, makes a reading, finding or line live on two NCs. The NC-based supplier PPM then counts units twice. | `20251113100000`, `20251218100000:313-334`, `20251217100000:217`, `20260106100000` | Reported |

## Medium

| ID | What | Where | Status |
|---|---|---|---|
| API-2 | The dashboard narrows to "the only readable site" when the organisation has one active site, and filters every figure by it. NCs with no site (portal complaints, imports, gauges without a site) or at a deactivated site vanish from the dashboard while the register and home page count them. | `ncr-dashboard.ts:87-93, 107` | Fixed, see below |
| API-3 | "Raised" and "open NC" are defined five different ways: the NC dashboard (drafts and cancelled count), supplier dashboard, customer dashboard, quality objective `ncr_count`, supplier register. These feed management-review inputs. | `ncr-dashboard.ts`, `supplier-dashboard.ts:177`, `customer-dashboard.ts:147`, `quality-objectives.service.ts:52`, `supplier-quality.service.ts:50` | **Open: needs a decision** |
| API-4 | Routes on the NC page need organisation-wide permission while the NC routes admit site-scoped people: inspection-source, audit-source, receipt-source / link / unlink, raise from a receipt line, raise / add from an inspection. A site-limited quality engineer opens an NC and the cards answer 403. | `inspection.controller.ts:106-170`, `audit-findings.controller.ts:234`, `requirements.controller.ts:84-103`, `receiving.controller.ts:133` | Fixed, see below |
| API-5 | `GET /exchange-rates/preview` needs no permission, has no date window and writes to the global rate cache (including "not published" rows for a week). Any member can loop pairs and dates. | `currency.controller.ts:28-34`, `exchange-rate.service.ts:97-117` | Fixed, see below |
| API-6 | Reporting NC datasets miss a deleted cost line on incremental pulls: the NC's `updated_at` does not move when a line is soft-deleted. | `20260425100000_reporting_keys.sql:131-163` | Fixed, see below |
| DB-3 | Disposition, affected-lot and containment limits and the stage gates are check-then-write with no row lock. Two proposals of 8 against 10 both pass; closing while someone adds an open action can commit both. | `20251212100000:207-330` | Fixed, see below |
| DB-4 | Changing an NC's part does not revalidate its order, lot, serial or affected lots (the production-links trigger returns early unless a link changed). | `20251211100000:84-95`, `20251212100000:78-82` | Fixed, see below |
| DB-5 | `raise_ncr_from_inspection` accepts corrected (superseded) readings and an abandoned inspection; `add_readings_to_ncr` refuses superseded ones. | `20251218100000:297-319` | Fixed, see below |
| UI-3 | Register selection goes stale: filter, search or sort changes keep the selected rows, so the header totals and "Export CSV" use rows no longer shown. | `NonConformance.jsx:164-167`, `TableWrapper.jsx:130-135` | Fixed, see below |
| UI-4 | Grid view has no paging: more than one page of NCs cannot be reached. | `NonConformance.jsx:348-357` | Fixed, see below |
| UI-5 | The selection's cost adds mixed currencies and labels the sum with the first row's currency; the cost-filter chip uses the row currency for an organisation-currency value. | `NonConformance.jsx:187-233` | Fixed, see below |
| UI-6 | Changing the part does not clear order, lot and serial; the server then refuses the save (and, with UI-2, the person's other edits go too). | `NcrPage.jsx:444` | Fixed, see below |
| UI-7 | The form does not say everything needed to open: "part or description" has no mark, Raise NC is enabled with only a title, "Needed to open" hints stay on an NC that is already open. | `NcrPage.jsx:313-321, 407, 444, 460, 488`, `StageBar.jsx:15` | Fixed, see below |

## Low

| ID | What | Where |
|---|---|---|
| UI-8 | No warning when leaving the NC page with unsaved edits (no blocker anywhere in `src`); "Discard changes" has no confirmation. | `NcrPage.jsx:326` |
| UI-9 | Cost preview can be a penny off the stored amount (`Math.round` against the database's `round(numeric, 2)`), e.g. 1 × 1.005. | `CostForm.jsx:61-67` |
| UI-10 | A hidden VAT rate can block Add cost with no message. | `CostForm.jsx:26, 111` |
| UI-11 | Editing a cost's date or currency silently drops a stated exchange rate (database rule), with no warning. | `CostForm.jsx:90-101` |
| UI-12 | The default "Detected on" is worked out once at load, so a tab left open past midnight starts with yesterday. | `formModel.js:6` |
| UI-13 | The register's filter count ignores the `order` and `lot` filters. | `NonConformance.jsx:190` |
| UI-14 | Dashboard "Closed in period" links to all closed NCs; links ignore the chosen site. | `NcDashboard.jsx:140-169` |
| UI-15 | When the dashboard request fails, the cards say "No NCs in this period". | `NcDashboard.jsx:123-129` |
| UI-16 | Affected lots: with no quantity set, the screen says every item is already placed. | `NcrAffectedLots.jsx:~204` |
| UI-17 | A native `<select>` in `StageBar`; hard-coded NC addresses in `lib/change.js`, `risk.js`, `fmea.js`, `reminders.js`, `integrations.js` instead of `ncrPath`. | `StageBar.jsx:50` |
| API-7 | The cost restate has no actor in the audit trail. | `cost-currency.service.ts:52` |
| API-8 | `GET /ncrs/{id}/costs` totals add `netBase` across lines with different base currencies (before a restate). | `ncr-records.service.ts:247` |
| API-9 | The job hub's recent-NC list reads every open NC and filters in JavaScript. | `jobs.service.ts:101-125` |
| API-10 / DB-10 | `detectedAt` accepts future and absurd dates; cost `incurred_on` has no future check. | `ncr.schemas.ts:47`, migrations |
| API-11 | Someone who can read an NC but not change it at that site gets 404, not 403. | `ncr.service.ts:526` |
| API-12 | The supplier register shows 0 NCs to people without `ncr.read` (should be unavailable). | `supplier-quality.service.ts:31-74` |
| API-13 | No client key on NC create, cost create, RMA, disposition: a double click or retry duplicates (money counted twice, RMA numbers burnt). | `ncr.service.ts:251`, `ncr-records.service.ts:57` |
| API-14 | Zod limits that pass and then fail the database (`quantity × unit cost` over the amount CHECK); raise-from-inspection text limits larger than the NC edit limits. | `ncr-records.schemas.ts:99`, `inspection.schemas.ts:289` |
| API-15 | Attachment metadata (size, type) is taken from the client; the same file can be listed twice. | `ncr-records.service.ts:121` |
| DB-6 | Responsible employee and containment owner are not checked as active; the people rule is not SECURITY DEFINER, so a custom role without `master_data.read` may be unable to create an NC (plausible). | `20260213100000:25-38` |
| DB-7 | Stage gates read the stored row, not the incoming one (only reachable by direct SQL today). | `20260125100000:43` |
| DB-8 | A closed NC still accepts receipt, 8D and SCAR links; links are not revalidated when the NC's supplier changes or it is cancelled or deleted. | `20260106100000`, `20251122100000:344`, `20251229100000:351` |
| DB-9 | Stage can drift from its gates after the move; quantity affected 0 makes the disposition gate vacuous (may be intended for system NCs: a question for the owner). | `20251209100000` |
| DB-10 | Legacy NCs copied as closed have no `closed_at`, so "closed in period" leaves them out; containment quantity and affected-lot quantity have no upper bound; RMA allowed on a draft; re-parenting a sub-failure mode does not revalidate NCs. | various |

Plausible, not confirmed: `app.ncr_gate_problems` returns no problems to someone without `ncr.read`, which a custom role
holding `ncr.update` without `ncr.read` could reach.

## Checked and found sound

Reference numbering and `pad_number`; `change_ncr_source` (locks, reason, party); disposition approve and cancel
(definer functions, frozen once approved); RMA numbers; cost arithmetic, rate and override functions, site and
organisation currency locks; history-import and costs-on-closed switches (transaction-local, definer only); history
imports raising no events or notices; organisation isolation (composite foreign keys, every `:id` route filtered);
child tables locked on closed, cancelled or deleted NCs; no DELETE grants; audit triggers on every NC table; trigger
order; list SQL safety (whitelists, escaped LIKE, `string_to_array`); error mapping; edit conflicts on NC and
containment; CSV export (formula guard, BOM, CRLF); saved filters; the containment, disposition, RMA and affected-lot
dialogs' limits; permission gating on the NC page.

## Suggested order of work

1. **Screens, no migration:** UI-1, UI-2 (and UI-6, UI-8 with them), then UI-3 to UI-5, UI-7.
2. **API, no migration:** API-1, API-2, API-3 (one shared "live NC" fragment and a comparison test), API-4, API-5, API-10.
3. **One migration:** DB-1, DB-2, DB-3, DB-4, DB-5, DB-6, DB-8 (and DB-7 if wanted), with SQL tests that fail first. Applying it live
   waits for the owner's go.
4. Decisions for the owner: DB-9 (quantity 0), API-3 (what "raised" and "open" mean everywhere: the NC dashboard counts drafts and cancelled NCs as raised; the other four places each use their own rule, and they feed management-review inputs), API-13 (client keys).

## Fixed so far (the five high findings)

Fixed on 28 Nov 2026. The high-findings migration (`20260469100000`) is applied live. **The medium-findings migration (`20260470100000`) is not applied live** (it waits for the owner's go).

| ID | Fix | Test |
|---|---|---|
| UI-1 | `NcrPage.jsx`: when the NC changes under the person, the fields they have edited keep their words and every other field takes the new value; a save sends the version the person opened (`useEditBase`), so a colleague's change to the same field is still caught. After the person's own save the form takes the saved record. | `Ncr.test.jsx` "NC form: what is typed is kept" (two tests that fail without the fix) |
| UI-2 | The NC page's own save is no longer guessed on screen (`optimistic: false` in `useNcrMutation`): a refusal leaves everything typed in place and nothing flickers back. | two more tests in the same block, using a real uuid because the guess only touches records with one |
| API-1 | `ncr-dashboard.ts`: the trend's total is the sum of the per-source counts. | `ncr-records.e2e-spec.ts` "counts every non-conformance of a week in the trend" |
| DB-1 | `20260469100000_ncr_audit_high_fixes.sql`: reopening a cancelled NC runs `assert_ncr_openable`; `ncr_keep_opening_fields` also keeps the customer of an open customer NC and the supplier of an open supplier NC. | `ncr_core.test.sql` |
| DB-2 | Same migration: `app.assert_ncr_links_free` re-checks on reopen and restore that none of the NC's readings or audit findings is on another live NC; `raise_ncr_from_inspection` and `add_readings_to_ncr` take a lock per inspection (`pg_advisory_xact_lock`) before checking, so two simultaneous raises cannot both pass. | `inspection_ncr_add_readings.test.sql` (reopen and restore). The race itself needs two sessions and is not covered by a test. |

## Fixed so far (the medium findings, except API-3)

| ID | Fix | Test |
|---|---|---|
| API-2 | `ncr-dashboard.ts`: a person who may read NCs organisation-wide sees every NC (also those with no site or at a switched-off site) unless they choose a site; only someone limited to a single site is narrowed to it. | `ncr-records.e2e-spec.ts` "shows an organisation-wide reader every non-conformance, also when only one site is active" |
| API-4 | The side cards of the NC page (inspection, audit and receipt source, link and unlink a receipt line, raise from a receipt line or an inspection, add readings) admit site-limited people (`anyScope`); the database still decides per record. | `ncr-records.e2e-spec.ts` "answers the side cards of an NC at their own site to a site-limited person" |
| API-5 | `GET /exchange-rates/preview` needs `ncr.update` (anyone who can enter costs) and refuses a day more than ten years back, so it cannot be used to fill the shared rate cache. | `cost-currency.e2e-spec.ts` (403 for a viewer, 400 for 1999) |
| API-6 | `20260470100000`: `report_non_conformances.updated_at` counts the latest change of any cost line, deleted ones too. | `ncr_audit_medium_fixes.test.sql` |
| DB-3 | Same migration: writing to dispositions, containment actions or affected lots takes the NC's row lock first (trigger `a_ncr_lock_parent`, before the rule triggers, SECURITY DEFINER so people who may not update the NC can still write), which is the lock the stage-gate trigger holds while it checks. | `ncr_audit_medium_fixes.test.sql` checks the triggers and their order; **the race itself needs two sessions and is not tested** |
| DB-4 | Same migration: changing an NC's part is refused when its production order, lot, serial number or a live affected lot belongs to another part (`nonconformances_part_change`). | `ncr_audit_medium_fixes.test.sql` |
| DB-5 | Same migration: `raise_ncr_from_inspection` refuses a corrected (superseded) reading and an abandoned inspection. | `inspection_ncr_add_readings.test.sql` |
| UI-3 | `NonConformance.jsx`: the register's selection is cleared when the page, page size, filters, search or sort change. | `Ncr.test.jsx` "forgets the selection when the rows on screen change" |
| UI-4 | The card view has Previous / Next with "Page N of M". | `Ncr.test.jsx` "pages through the cards when there is more than one page" |
| UI-5 | The selection's cost is added per currency ("£292.40 + €100.50"); the cost-filter chip uses the organisation currency (what the filter works on). Also UI-13: the filter count includes the order and lot filters. | `Ncr.test.jsx` "adds the selected rows' costs per currency…" |
| UI-6 | Choosing another part clears the revision, production order, lot and serial number chosen for the old one. | `Ncr.test.jsx` "clears the production order and lot when the part is changed…" |
| UI-7 | **Raise NC** stays disabled until what the database needs to open is filled in (`openingProblems` in `formModel.js`, the same list as `assert_ncr_openable`) and its tooltip says what is missing; a part or a description is marked as needed; "Needed to open" hints show only on new and draft NCs; a draft's **Open this NC** says what it still needs and waits. | `Ncr.test.jsx` (four tests) |

**Open:** API-3 needs an owner decision (below). Everything in the Low list is untouched.
