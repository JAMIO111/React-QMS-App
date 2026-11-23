# Record filters for imports — plan

Agreed with the owner 2026-11-23. Slices F1–F4; **F1 (engine, database, API) built**.

## 1. What was asked
A way, before the mapping, to filter out certain records from an import. A new step where the user picks one or more filters.

## 2. Decisions
- **F-D1 (where):** a **"Filter records" step between "Upload a file" and "Map columns"** in the file wizard, and a card above the mapping on the API / agent mapping page. It applies to every connection that uses templates (files, REST APIs, connector-agent databases / folders / APIs), because the filter runs in the sync engine.
- **F-D2 (rules):** simple rules (`column + test + value`), combined **all of** or **any of**, each filter **keeps** or **leaves out** the records that match; plus a **formula** alternative (the existing mapping formula language; rules *or* a formula, never both). No nesting.
- **F-D3 (tests):** equals, does not equal, contains, does not contain, starts with, ends with, is one of, is not one of, is empty, is not empty, and (read as a number or a date) more than, at least, less than, at most, between.
- **F-D4 (saved where):** on the **template version**, inside its `settings` (`settings.filters`), so it is frozen with the version, brought back with it, copied by duplicate, and carried into a run's frozen settings (scheduled runs too). A changed filter is a new version and needs a reason, as any change does.
- **F-D5 (before mapping):** the filter looks at the **raw source columns**. A record it leaves out is never mapped, checked or written. It is staged as `skipped` with `filtered = true` and the reason ("Filtered out: …"), so nothing disappears silently.
- **F-D6 (filtered is not missing):** a record the filter leaves out is still in the source. The database keeps the source's own identifier of a filtered record (`integration_inbox.source_external_id`, kept apart from the row's identifier so it cannot clash with a kept record) and **records that disappeared (IN8) counts it as present**. A filtered row whose identifier cannot be read could be any record, so nothing is called missing from that read (as for a row with no identifier). A filter can therefore never deactivate records by accident.
- **F-D7 (cannot be judged):** a formula that fails for a record does **not** quietly drop it: the row is rejected with "Filter formula: …".
- **F-D8 (warn, don't block):** a filter that keeps almost nothing is warned about (F3), not refused.
- The existing field **Leave this row out** (goods receipts) stays as it is; this step is the easy front door for the common case.

## 3. Slices
- **F1 (built):** `core/filters.ts` (rules, formula, validation, words; unit tests), migration `20260423100000_import_filters.sql`, the engine, the template API, `POST /integrations/templates/filter-preview`, run counts `filtered`.
- **F2:** the wizard step and the card on the API / agent mapping page: rule builder with column combos (the file's real headings and examples), live "N of M kept", counts per rule, a few records of each kind.
- **F3:** run page "Filtered out" tile and list; the warning when a filter keeps under about 10% of rows; a scheduled import whose filter suddenly removes everything is flagged in the health card.
- **F4:** exit check: browser journey step, live checks, exit report.

## 4. What F1 built
- **Database** (migration `20260423100000_import_filters.sql`, **not yet applied live**): `integration_inbox.filtered` and `.source_external_id`; `integration_sync_runs.filtered` (a subset of `skipped`); `app.integration_filter_problem(jsonb)` (the shape: keys, mode, match, ≤ 20 rules, ≤ 100 values, ≤ 500 characters each, ≤ 2,000-character formula, rules xor formula); `app.integration_template_settings` is now a wrapper over `…_core` (the old function renamed) that validates and keeps `filters` and drops one with nothing to do; `app.system_stage_integration_records` takes `filtered` / `sourceExternalId` per record and counts filtered; `app.integration_detect_missing` treats filtered records as present. All by checked text patches (`pg_temp.patch`).
- **API:** `TemplateSettingsBody.filters` (`FilterBody`), versions carry `settings.filters`; saving checks the filter against the template's expected columns and tidies it (empty rules dropped, nothing left = no filter); the engine reads the run's settings once per drain (`app.system_integration_run_settings`) and applies the filter to every fetched record before the mapping; `POST /integrations/templates/preview` marks each shown row `filteredOut` (and shows no mapping errors for a row that would not be imported); `POST /integrations/templates/filter-preview {entityType, fileId | connectionId, filter}` (`integrations.run`) counts every row of an uploaded file (an API or a database gives its sample, `complete: false`): kept, left out, per rule, a formula's failures, five of each; run counts carry `filtered`.
- **Frontend:** `templateSettings()` carries `filters` through, so saving a new version of a template never drops one (F2 builds the screens).
- Tests: `core/filters.spec.ts`, `supabase/tests/import_filters.test.sql` (three deliberate breaks caught), `api/test/integration-filters.e2e-spec.ts`, `CostImport.test.jsx`.
