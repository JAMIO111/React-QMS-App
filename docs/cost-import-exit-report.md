# Importing NC cost lines (and NC stages): exit report

Plan `docs/cost-import-plan.md`, decisions CI-D1 to CI-D13. Slices IN-NC, IC1 (database), IC2 (API), IC3 (screens) and IC4 (this check). 2026-11-22/23.

## What was built
- **NC stages on import** (migration `20260420100000_nc_import_stage.sql`): Stage, Closed on and Reason cancelled on the non-conformance import; history raises no event and no notice.
- **Cost lines** (migration `20260421100000_ncr_cost_import.sql`): kind `ncr_cost`, add only, converted by the table's own triggers on each line's own date, the source's booked value optional (the line becomes Actual), a negative cost refused, closed or cancelled non-conformances accepted only for ones an import brought in and only when the template says so.
- **API:** the exchange rates a run's lines need are fetched before any line is written (`SyncEngine.warmRates`), the run answers with a currency summary (`run.costs`).
- **Screens:** the "NC cost lines" tile, the closed-NC switch on the template, Match by for the link to the non-conformance, a currency notice in the mapping step, a "Currencies and rates" card on the run page, non-conformances in the allowed-values list.

## Evidence
- Frontend: `npm test` 1,993 passing (17 new in `CostImport.test.jsx`), lint 0 errors, build passes.
- API/database (IC1, IC2): SQL suite 166/166, API unit 461, API e2e 1,321 passing; deliberate breaks caught (map check, source check, permission check, negative allowed, pre-fetch removed; four in the stage migration).
- **Browser journey** (`npm run journey`, step `costImport()`, passes with the whole journey): non-conformances arrive open, closed and cancelled from a file; a five-line cost file in EUR, USD, CHF and the site currency is previewed (writes nothing: currencies table, "1 line will wait for a rate", closed and cancelled counts, the booked value) and imported (a line converted on its own date at the published rate, one Actual from the booked value, one waiting, one in the site currency, the credit rejected); the closed non-conformance's page shows its costs and the waiting notice; once the rate is in the cache the worker fills the waiting line in and the notice goes. Screenshots `cost-import-*.png` in the journey output.
- **Live:** migration applied through the SQL editor (the history list has no row for it, as for the other editor-applied migrations); live check of the four new functions, the patched shared functions and their privileges (nobody but `qms_api` can run the rate-fetch function, nobody signed in can run the importer); the function guardrails (no anon execute, fixed search path) have no violations; the migration adds no tables or columns so the table rules cannot have changed. Advisors: only the two older warnings (GraphQL table exposure, leaked password protection).

## Not built / limits
- Cost lines are **add only**: a changed amount in the source is not applied; a correction is a new line, a credit is a supplier recovery or customer charge.
- The currency figures for a file are on the run page (preview and finished), not the mapping step: the template preview has no rates.
- Not tried against the real Frankfurter service (the journey and tests use the rate cache / a fake source).
- A cost file linked by the Fortress reference rather than the source id is covered by the API e2e test, not by the journey.
