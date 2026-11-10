# Import templates, step-by-step transforms and formulas (UI2) — plan

Slice UI2 of the import engine (`docs/import-engine-plan.md`). Builds on the file import wizard and mappings (IN3, IN4, UX1) and the custom fields
in the catalogue (CF4). Nothing is rebuilt in parallel: today's mappings become versions of templates.

## 1. Agreed decisions (2026-11-10)

| # | Decision |
|---|---|
| T1 | **Templates are organisation-wide**, not tied to one connection. A run still belongs to a connection; it is pinned to the template version it used. |
| T2 | **The formula language is built now** (UI2b), alongside the step-by-step transforms. |
| T3 | **Previews come from the server only.** The wizard asks the API how the first rows come out (debounced ~300 ms), so the screen and the import always agree. The browser's copy of date / number reading (`readDate`, `exampleValue`) goes. |
| T4 | **Only Controller-seat holders manage templates**: `integrations.manage` (which already needs a Controller seat). Running an import with a template stays `integrations.run` + the write permission for the kind of record. |
| T5 | **Unit conversions are a fixed list for now**: length (mm, cm, m, in, ft), mass (g, kg, lb, oz) and temperature (°C, °F). No organisation-defined factors. |

## 2. Templates

- `integration_templates`: organisation, kind of record, name (unique per organisation and kind ignoring case), description, `archived_at` / reason,
  current version. Archived templates are hidden from pickers, kept for the runs that used them, and can be restored.
- `integration_template_versions`: frozen once saved. Holds:
  - **source settings** — headings, character set, separator (today's per-upload options; a later slice adds the Excel sheet);
  - **expected columns** — the headings of the file it was saved against (for the column warning);
  - **key column** and **field rows** (§3);
  - **matching** — match existing records, and per link field match by code or by source id;
  - **import settings** — write mode (add new only / add and update / update only); NCs stay add only.
  A new version needs a reason; an unchanged one is refused; "bring back version N" saves N's content as a new version with a reason.
- **Duplicate** copies the current version into a new template ("Copy of …").
- **Runs** freeze `template_version_id` (the existing `mapping_id` stays for runs made before templates).
- **Migration of what exists:** every connection's current mapping (and its import settings) becomes a template named after the connection and the
  kind of record, version 1 = that mapping; older mapping versions are kept as earlier versions in order. `integration_mappings` stays readable for
  old runs and is no longer written.
- **Column check:** when a template meets a file, the API reports columns the template uses that the file lacks (blocking for required fields,
  a warning otherwise) and new columns the file has. The wizard shows it before Preview / Import.

## 3. Field rows: a source, then steps

A field row is `{ target, source | formula, steps[], default, match }`:

- **source** — one column, or a formula (§4) instead of a column.
- **steps** — an ordered list from a closed set (no code). Each step has a `kind` and its own settings:
  - text: `trim`, `upper`, `lower`, `title`, `replace` (find, with; plain text, all occurrences, optionally ignoring case), `remove` (characters),
    `left` / `right` (N characters), `split` (separator, take part N), `prefix` / `suffix`, `collapse_spaces`;
  - number: `number` (decimal mark, thousands separator), `round` (N places), `multiply` / `divide` (by a number), `convert` (from unit, to unit; §1 T5);
  - date: `date` (format: ISO, day/month/year, month/day/year, Excel serial, or a pattern such as `dd.MM.yyyy`), `add_days` (N, may be negative);
  - logic: `map` (lookup table: from → to, ignoring case and spaces at the ends; unmatched values kept or refused), `if` (when the value
    equals / does not equal / contains / starts with / is empty / is not empty / matches one of a list → then value, else value or keep),
    `coalesce` (first non-empty of several columns), `join` (columns and literal text with a separator), `default` (when empty).
- **Today's transforms map onto steps**: none → no steps; upper / lower → that step; map → `map`; constant → a formula of the text; concat → `join`;
  `dateFormat` → a `date` step; `decimal` → a `number` step. Existing mappings keep producing the same values (unit-tested against the old engine).
- After the steps the value is converted and checked against the field's type exactly as now (catalogue rules, references, custom fields).

## 4. Formula language

- **Values:** text, numbers, true / false, dates, and empty. Column references `[Column name]` (any heading, spaces allowed; `]` written `]]`).
  Literals: `"text"` (`""` for a quote), numbers with a `.` decimal point, `TRUE`, `FALSE`.
- **Operators:** `&` (join text), `+ - * /`, comparisons `= <> < <= > >=`, `AND`, `OR`, `NOT`, brackets.
- **Functions (closed list):** text — `CONCAT`, `LEFT`, `RIGHT`, `MID`, `LEN`, `UPPER`, `LOWER`, `PROPER`, `TRIM`, `SUBSTITUTE`, `FIND`, `SPLIT`
  (text, separator, part); logic — `IF`, `IFS`, `IFEMPTY`, `COALESCE`, `ISEMPTY`, `IN` (value, list…), `SWITCH`; number — `NUMBER` (text, decimal
  mark), `ROUND`, `ABS`, `MIN`, `MAX`, `CONVERT` (value, from unit, to unit); date — `DATE` (text, format), `TODAY`, `ADDDAYS`, `YEAR`, `MONTH`, `DAY`.
- **Safety:** parsed by a hand-written parser into a tree, evaluated by a tree-walker on the server. No variables, loops, user functions, network,
  database or file access; depth ≤ 32, length ≤ 2,000 characters, evaluation time bounded per row. A formula that fails on a row rejects that row
  with the formula's message ("Row 12: SPLIT needs a separator").
- **Errors when saving:** the parser reports the position and what was expected ("Column [Stauts] is not in the file — did you mean [Status]?",
  "IF needs 2 or 3 values, got 4").

## 5. Preview endpoint (T3)

`POST /integrations/templates/preview` with `{ entityType, fileId, template body (unsaved), rows? }` → for the first 20 rows (or the rows asked for):
each field's raw value, the value after each step, the final value, and the row's errors; plus the column check (§2). Used by the field row (the
example shown and the "after each step" view), the formula editor (live result) and the step editor. It writes nothing.

## 6. API

- `GET /integrations/templates?entityType&archived=include`, `POST /integrations/templates`, `GET|PATCH /integrations/templates/{id}` (name,
  description), `POST …/{id}/versions` (new version with reason), `GET …/{id}/versions[/{n}]`, `POST …/{id}/duplicate|archive|restore`,
  `POST …/{id}/restore-version {version, reason}`, `POST /integrations/templates/preview`, `POST /integrations/formulas/check` (parse only).
- `POST /integrations/connections/{id}/runs` takes `templateId` (its current version is frozen on the run); the run carries `template {id, name, version}`.
- Writes: `integrations.manage` (T4); reads and preview: `integrations.read` / `.run`. Errors `QM022` → `409 integration_rule`.

## 7. Screens

- **Simple import (the three-step wizard) stays.** Step 3 gets a **template picker** ("Use a template", or start from the last one used for this kind
  of record) and **Save as template / Save a new version** (managers only). The column check shows above the field rows.
- **Field row** (expanded): the source (column, or "Use a formula"), the steps as a list (add, reorder, remove, each with its settings) and, beside
  each step, the value after it for the example row (from the preview). Steps are offered to everyone who can import; saving them into a template
  needs `integrations.manage`.
- **Formula editor:** a text box with column and function suggestions, the parser's message under it, and the live result for the example row.
  Shown when the organisation's **advanced import** setting is on (E6), as is the template manager.
- **Template manager** (Settings → Integrations → Templates): list by kind of record (name, version, last used, runs), versions with reasons and
  what changed, duplicate, archive / restore, bring back a version.

## 8. Slices

| Slice | Content |
|---|---|
| **UI2a** (done) | Migration: templates, versions, runs pinned to versions, existing mappings carried over, advanced import setting; SQL tests, guardrails, sweeps. API: step engine (`core/steps.ts`, unit tests incl. old-engine equivalence), templates endpoints, runs with a template; e2e. |
| **UI2b** (done) | Formula language (`core/formula/` parser, evaluator, functions, messages; unit tests incl. hostile input), formulas in field rows, preview endpoint, formula check; e2e. |
| **UI2c** | Screens: template picker / save in the wizard, step editor, formula editor, column check, template manager; component tests. |
| **UI2d** | Exit check: full suites, CLAUDE.md, this plan's status. |

Each slice: nothing pushed until told; migrations sent to be applied live first.
