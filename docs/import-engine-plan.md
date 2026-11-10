# Universal import engine — plan

From the brief *Fortress – Universal Import & Mapping Wizard* (Nov 2026), set against what the integrations module already has
(`docs/connectors-plan.md`, slices IN1–IN4 and the file import wizard). Builds on that module; nothing is rebuilt in parallel.

## 1. Agreed decisions (2026-11-10)

| # | Decision |
|---|---|
| E1 | **Background work runs on Supabase pg_cron**, which calls the API's existing cron endpoint every minute to work the import queue (works on the dev deployment too). |
| E2 | **Custom fields come first**, as their own slices, planned separately (`docs/custom-fields-plan.md`). The import catalogue then offers each organisation's custom fields like any other field. |
| E3 | **Duplicates are always flagged in the preview.** For transactional records (non-conformances and the like) the person may override and import them anyway; for **master data** (gauges, gauge types, machines, parts, suppliers, customers, employees) a duplicate is never created. |
| E4 | Field overwrite rules: always / only if the Fortress value is empty / never / send to review. **No "only if the source is newer" rule.** Blank source cells never overwrite by default. |
| E5 | **No AI mapping assistant for now.** Heading-based suggestions stay. |
| E6 | **Simple import stays** (the three-step CSV wizard); an **advanced import** setting adds the extra steps (relationships, behaviour, validation report) for those who want them. |
| E7 | Order: **custom fields → UI2 → UI4 → UI5 → UI6 → UI3 → UI7 → UI8.** |

Also agreed in discussion: no new parallel tables (mappings become template versions, runs become jobs); a closed formula language parsed
on the server instead of JavaScript; the destination registry stays in code, declared by each module beside its own code; undo is
compensating (deactivate untouched created records, revert untouched updated fields), never a delete; imports keep every business rule.

## 2. Slices

| Slice | Content |
|---|---|
| **CF** | Custom fields (separate plan). |
| **UI2** | Templates and transform pipelines: per-field ordered steps (text, number, date, logic), the formula language, conditional mappings, templates bundling source settings + mapping + matching + import settings (duplicate, archive, restore a version), a warning when a reused template meets different columns. |
| **UI4** | Relationships and multi-file imports: several files and kinds of record in one import, dependency order from the catalogue's links, links resolved inside the import before writing, multi-field / composite matching, "create the missing linked record" where allowed, cycles and missing links reported in the preview. |
| **UI5** | Duplicates and overwrite rules (E3, E4): strategies, per-field rules, the review queue for flagged conflicts. |
| **UI6** | Validation report and execution: errors vs warnings, duplicates inside the file, error report download, "import valid rows only", the pg_cron worker (E1) with live progress, cancel, history, undo of an import. |
| **UI3** | Sources: JSON, XML (record path, nested values), choosing the Excel sheet, row filters, excluding records, a source preview browser. |
| **UI7** | The advanced wizard (E6): source, configure, destination, map, relationships, behaviour, validate, run; drag-and-drop mapping; drafts saved on the server; template manager. |
| **UI8** | REST adapter (IN7), schedules and incremental sync (IN8), SQL databases through an agent on the customer's network. |

Each slice: migration + SQL tests, API + e2e, UI + component tests, sweeps updated, CLAUDE.md updated, nothing pushed until told.
