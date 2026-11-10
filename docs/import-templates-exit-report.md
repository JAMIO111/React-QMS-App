# Import templates, steps and formulas — exit report (UI2d)

Slice UI2 of the import engine (`docs/import-templates-plan.md`, decisions T1–T5). Date: 2026-11-10.

## 1. What was built

| Slice | What | Migration |
|---|---|---|
| UI2a | Organisation-wide import templates with frozen versions; runs pinned to a template version; existing mappings carried over; step engine (closed list of 24 steps, fixed unit list); template API | `20260119100000_integration_templates.sql` — applied live 2026-11-10 (3 mappings → 2 templates, 3 versions) |
| UI2b | Formula language (hand-written parser and tree-walking evaluator, closed function list); formulas in field rows; server preview of unsaved templates; formula check and function list | none |
| UI2c | Screens: template picker / save / new version in the file import, import settings on the template, step editor, formula editor (advanced imports only), column check, examples from the server preview, template manager, advanced imports switch | none |
| UI2d | Browser journey step, two app fixes found by it, this report | none |

## 2. Decisions kept

- **T1** Templates belong to the organisation; a run belongs to a connection and is pinned to the template version it used (`integration_sync_runs.template_version_id`). Checked: e2e "an import with a template … is pinned to its version" and the journey (run page names "template … version 1").
- **T2** The formula language is built: `[Column]`, text, numbers, `TRUE/FALSE`, `& + - * / = <> < <= > >= AND OR NOT`, 33 functions. No variables, loops, user functions, network, database or file access; ≤ 2,000 characters, nesting ≤ 32, ≤ 20,000 evaluation steps and ≤ 10,000-character text per row.
- **T3** Previews come from the server only. The browser's own value reading (`exampleValue`, `readDate`) was removed; the mapping editor, step editor and formula editor show what `POST /integrations/templates/preview` and `POST /integrations/formulas/check` answer. The journey checks that the import wrote exactly what the preview showed ("BIG LATHE", "big lathe in Bay 1").
- **T4** Only `integrations.manage` (which needs a Controller seat) saves, versions, renames, duplicates, archives or brings back a template. Others with `integrations.run` may try changes and see the preview, but an import waits until the change is saved. Checked: SQL test (permissions), e2e (403), component test ("Ask someone who manages integrations…").
- **T5** Unit conversions are the fixed list mm/cm/m/in/ft, g/kg/lb/oz, °C/°F.

## 3. Evidence

| Check | Result |
|---|---|
| `npm run db:check` (UI2a) | all SQL tests pass incl. `integration_templates.test.sql`; 4 mutants of the new functions caught |
| `npm run api:test` | 237 passed (incl. `core/steps.spec.ts` with old-transform equivalence, `core/formula/formula.spec.ts` with hostile input) |
| `npm run api:test:e2e` | 796 passed (incl. `integration-templates.e2e-spec.ts`, both tenancy sweeps) |
| `npm test` | 1,194 passed (115 files), incl. `ImportTemplates.test.jsx`, `IntegrationFiles.test.jsx`, `NcrWorkflow.test.jsx` |
| `npm run lint` / `npm run build` | 0 errors / builds |
| `npm run journey` | **passes end to end**; new step: switch on advanced imports → upload `machines.csv` → Capitals step on Name and `CONCAT([Name], " in ", [Area])` on Description, values shown by the server preview → save as a template and import → database holds `BIG LATHE` / `big lathe in Bay 1` → template manager shows version 1 with the step and the formula. Screenshots `60-import-mapping-steps-formula`, `61-import-run`, `62-template-manager`. |
| Live database | migration applied and checked (tables, columns, functions, carried templates) |

The journey's fake Supabase now keeps uploads in memory and the API's file store reads them back from there (`scripts/journey/stack.cjs`), so file imports run in the browser journey without real storage.

## 4. Found and fixed during the exit check

1. **Inherited properties read as columns** (UI2b, hostile-input tests): a file column named `constructor` or `__proto__` read the JavaScript object's own machinery. Rows are now read with `cell(record, column)`, own properties only — this also fixed ordinary imports, not only formulas.
2. **A field filled only by a "default" step counted as having no source** (UI2c): an operator-precedence slip in `rowHasSource`; rewritten and tested.
3. **Acting on a row that was still saving** (journey): NC dispositions and containment actions are shown at once while they save (optimistic) under a placeholder id; their Approve / Done / Edit / Cancel buttons were live in that moment, and a quick click sent the placeholder id (`400 Invalid uuid`). Such rows now show "Saving…" and offer nothing until the server answers; saved filters still saving have Rename / Delete switched off. Component tests added.
4. **The journey had fallen behind earlier changes**: the quality-alert set-up still sent `requiredAction` (now `actions`), and the disposition dialog's Lot is a combo box now. Both updated; the whole journey passes again.
5. A switch wired with `onClick` and no `onChange` (Advanced imports) logged a React warning; now `onChange`.

## 5. Not built / limits

- Excel sheet choice in source settings (the first worksheet is read, as before).
- Organisation-defined unit conversions (T5: fixed list for now).
- A template's source settings are saved with it but not yet applied automatically to the next upload (the person chooses how to read the file on step 2).
- Templates for API connections (REST arrives in IN7; the same template engine will serve it).
- The template manager has no search and no comparison between two arbitrary versions (each version shows what changed from the one before).
- The connection-level mapping endpoints (`GET|PUT /integrations/connections/{id}/mapping(s)`) still exist for old runs and are no longer used by the screens; they can be retired once nothing calls them.
- Not checked against a real Supabase Storage bucket in the browser journey (a stand-in is used); the API's storage reader is unchanged since IN3.
