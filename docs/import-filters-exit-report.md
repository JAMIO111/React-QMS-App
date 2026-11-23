# Record filters for imports — exit report

Slices F1–F4 (`docs/import-filters-plan.md`). A way to choose which records of a source an import reads at all, before anything is mapped. Applies to every
connection that uses templates: uploaded files, REST APIs and connector-agent databases, folders and internal APIs.

## What was built
- **F1 — engine, database, API.** A filter (`core/filters.ts`: rules of column + test + value, combined all / any, keeping or leaving out the matches, or one
  formula) is kept in the template version's `settings.filters`, frozen with it and copied into a run's settings, so a scheduled import uses exactly what was
  previewed. The sync engine applies it to the raw source record **before mapping**. A record it leaves out is staged `skipped`, marked `filtered` and counted in
  `runs.filtered`; a formula that fails for a record rejects the row ("Filter formula: …") instead of quietly dropping it. A filtered record keeps its own source
  identifier (`integration_inbox.source_external_id`), so **a record the filter leaves out is never reported as "no longer in the source"** and a filter can never
  deactivate records by accident. `POST /integrations/templates/filter-preview` counts every row of an uploaded file (an API's or database's sample) rule by rule.
- **F2 — screens.** The file wizard has four steps (Choose records, Upload a file, **Filter records**, Map columns); API and agent mapping pages have a Filter
  records card. One rule builder (`FilterBuilder.jsx`) with the server's live "N of M kept", per-rule counts, problems and a few records of each kind. A half-typed
  rule is never sent or saved (`cleanFilter`).
- **F3 — run page, warnings, health.** A "Filtered out" tile and rows choice on the run page (with the reason each record was left out); a warning when the filter
  left out every record or kept under a tenth of 10 or more (also on the filter step; **a warning, never a block**); the import health card flags a scheduled
  import whose filter left out every record, or at least 90% of 10 or more, it read.
- **F4 — this check.**

## Evidence
- Migrations `20260423100000_import_filters.sql` (F1) and `20260424100000_import_filters_run_page.sql` (F3), both **applied live** and checked (columns, functions,
  patched functions, index, no `anon` or signed-in access to system functions).
- Live guardrail rules 4 (no `anon` function privilege), 5 (signed-in users cannot call the template-settings functions) and 7 (fixed `search_path`): 0
  violations; neither migration adds a table, so rules 1, 2 and 8 are unchanged. Row-level security is on for the inbox and runs tables.
- Security advisors: nothing about any new object (the findings are the earlier, known ones).
- Tests: `core/filters.spec.ts` (15), `supabase/tests/import_filters.test.sql` (deliberate breaks caught: the stage patch, the missing-records patch, privileges;
  extended in F3), `api/test/integration-filters.e2e-spec.ts` (10), `lib/importFilters.test.js`, `IntegrationFiles.test.jsx` (filter step, run page),
  `ApiMapping.test.jsx`, `KeepHealthy.test.jsx`. Frontend: 194 files, 2,014 tests; full `npm run db:check` passes.
- **Browser journey** (`recordFilters()` in `scripts/journey/journey.cjs`): a file of four machines imported through the wizard with a filter on Status — the
  filter step warns that "Nothing" keeps nothing, then says "2 of 4 records kept" and shows the skipped records; the mapping step shows the filter in words; the
  import writes only the two active machines; the run page says 50% were left out and lists them with the reason; the template version keeps the filter.

## Limits and decisions to remember
- The filter reads the **raw source columns**; it cannot look at anything Fortress holds (no "only records not already imported"). The write mode and field
  ownership already cover that.
- A filter belongs to the template version. Choosing another template in the mapping step replaces the filter chosen in the filter step with that template's own
  (the template card sits in the mapping step). Someone who wants a filter on a different template picks the template first (`?template=` in the address).
- An API or database source is previewed from the **sample** it sends (the first page or rows), so "N of M kept" says it counted only the sample.
- Records the filter leaves out are not deleted from anywhere: changing the filter and importing again reads them.

## Not built
- A filter on part revisions or purchase order lines' children (nothing new: the kinds that import are covered as any other).
- Notices or email when a scheduled import's filter leaves out everything (the health card flags it).
- Saved filters shared between templates, "only records changed since" as a filter rule (the incremental read already does that where a source has a changed
  column).
