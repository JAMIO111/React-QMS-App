# Edit conflicts — plan

**Status:** decisions EC-D1–EC-D6 agreed 2026-11-17 (as proposed) · slices EC1–EC4 · **EC1 built and applied live** (migration `20260324100000_edit_conflicts.sql`, SQL test `supabase/tests/edit_conflicts.test.sql`) · **EC2 built** (API, no migration, pushed) · **EC3 built** (screens; one API addition, no migration)

## 1. The problem (inspected)

Two people can open the same record, both edit it, and both save. **The last save wins and nobody is told.**

- There is no version check anywhere: no row version, no `updated_at` comparison, no `If-Match`, in the API or the screens (searched 2026-11-17).
- Saves send only the changed fields (the NC page compares the form with what it loaded, `changedFields` in `NcrPage.jsx`; the PATCH routes write only the keys sent). So **two people changing different fields both keep their change**. **Two people changing the same field**: the later one silently overwrites the earlier one, and the earlier person's screen keeps showing their own value until it refetches.
- A screen shows what it loaded until it refetches (revisit, window focus, a few polls). Nothing pushes another person's change to it.
- Not lost: `audit.events` keeps every save with who, when, the fields changed and the old and new values.
- Already safe: everything the database decides — stage gates, quantity limits, frozen records, one-of rules, and the lifecycle steps (approve, complete, issue, close), which are single locked function calls whose second caller is refused.

The exposure is **plain field edits on a form held open** (titles, descriptions, dates, owners, notes, rich text) while someone else saves the same record.

## 2. What we have to build on

| What | Where | Use |
|---|---|---|
| `updated_at` / `updated_by` set on every update by `app.touch_updated()` (`now()` = the transaction's start, microseconds) | ~90 tables; every table edited by a PATCH route except `integration_connections` and `workflow_rules` (they set `updated_at` themselves) | the version |
| Every update locks its row | Postgres | a check inside the update cannot race |
| `audit.events` (`entity_type`, `entity_id`, `changed_fields`, `previous_values`, `new_values`, `actor_user_id`, `created_at`; indexed by organisation, entity, time) | append-only trail | which fields someone else changed since you loaded, and who |
| PATCH bodies hold only changed fields | NC page and most routes | non-overlapping changes can be merged without asking |

One trap: the API turns `updated_at` into a JavaScript `Date`, which **drops the microseconds**, so the timestamp as the API sends it today cannot be compared exactly. The version must be sent as its own exact value.

## 3. How it works

1. **Version on every editable record.** Responses carry `rowVersion` (not `version`: audits, workflow rules and part revisions already use that name) = `updated_at` as whole microseconds since 1970, as text (`app.row_version(updated_at)`). Nothing new is stored.
2. **A save says what it was based on.** A PATCH body may carry `rowVersion` (or the request an `If-Match` header). The API sets it for the transaction (`app.expected_versions`, `{ "<table>:<id>": "<version>" }`).
3. **The database checks it, in the update.** `app.touch_updated()` (replaced) looks for its row in `app.expected_versions`; when the row's current version differs it raises `QM031` naming the row; when it matches it removes the entry, so further updates of the same row in the same request (stage recomputes, triggers) are not mistaken for conflicts. Because the check runs inside the update, which holds the row lock, two saves can never both pass. It works the same for updates under RLS and inside SECURITY DEFINER functions.
4. **The API answers `409 edit_conflict`** with what changed since your version: `{ version, changedBy, changedAt, fields: [...] }`, taken from `audit.events` by `app.edit_conflict_details(table, id, since_version)` (only for a row the caller has just read under its own RLS in the same request; field names, who and when — values come from the record the caller may read).
5. **The screen decides what to do** (EC-D3):
   - **Nothing you changed was changed by them** → save again on the new version without asking, then say "Colin also changed Severity; both changes kept."
   - **A field you changed was changed by them** → a dialog per clashing field: their value, your value, **Keep mine** / **Take theirs**; then save on the new version. Cancel leaves your typing on screen, unsaved.
   - **Rich text** (document drafts, review minutes) cannot be merged field by field: "Colin saved this draft at 10:42. **Load theirs** (your text is kept in a copy you can paste from) / **Overwrite with mine**."
6. A save **without** `version` behaves as today (last write wins): imports, scripts, the worker, older clients.

## 4. Decisions (agreed 2026-11-17 as proposed)

| | Question | Proposed |
|---|---|---|
| **EC-D1** | What is the version? | **`updated_at` to the microsecond**, sent as text. No new column, no backfill. (Alternative: an integer `row_version` column on ~60 tables, one migration each — more churn for the same result.) |
| **EC-D2** | Where is it enforced? | **In the database**, in `app.touch_updated()`, from a transaction setting the API fills. Race-free and the same for every kind of write. (Alternative: the API reads and compares first — needs a lock it cannot always take on function-only tables.) |
| **EC-D3** | Changes to different fields | **Merged without asking, with a note.** Only a clash on the same field asks. (Alternative: always stop and ask — safer-feeling but noisy, because background changes such as an 8D's stage recompute also move the version.) |
| **EC-D4** | Must every save send a version? | **No: optional.** The screens always send it; imports, the worker and scripts do not. |
| **EC-D5** | Which screens first | **NC page, 8D steps and header, risk page, document drafts, management review (inputs and minutes), audit template form, quality alert drafts, control plan revision drafts, supplier profile, part / gauge / machine dialogs, the "More details" custom fields card**; then the remaining edit dialogs (actions, contacts, lines). |
| **EC-D6** | Seeing who else is on the page ("Colin is viewing") | **Not in this slice.** It needs the push channel discussed separately; this plan only stops silent overwrites. |

## 5. Slices

| Slice | Content |
|---|---|
| **EC1 — database** | Migration: `app.row_version(timestamptz)`, `app.touch_updated()` replaced with the check (`QM031`, consumed after the first match), the same check for `integration_connections` and `workflow_rules`, `app.edit_conflict_details`. SQL test: matching version saves; stale version refused for an RLS update and for a SECURITY DEFINER function update; a second update of the same row in one request is not a conflict; no setting = as today; details list the right fields, who and when, and nothing for a row in another organisation. Guardrails unchanged (no new table). |
| **EC2 — API** (built) | `@Versioned('<table>')` on a record's GET and PATCH (`api/src/common/versioned.ts`, global `VersionInterceptor`): `rowVersion` + `ETag` on the answer; PATCH bodies take `rowVersion` (removed before the strict body check) or `If-Match`; `DatabaseService.asUser` sets `app.expected_versions`; `QM031` → `409 edit_conflict` with the details; field names mapped back to the API's names (snake → camel, with a small table for the exceptions). e2e: two people on one record per route in scope (different fields → both kept; same field → 409 with the right details; no version → last write wins). Tenancy sweep unchanged (the body field is optional). |
| **EC3 — screens** | `apiFetch` / a shared `useVersionedSave` that sends `version`, retries a non-clashing conflict once on the new version, and raises the clash dialog (`ui/EditConflictDialog.jsx`) otherwise; the rich-text choice for document drafts and review minutes; optimistic quick edits (custom fields card, review inputs, job details) roll back and show the clash instead of a generic error. Tests per screen in scope. |
| **EC3 — screens** (built) | See §7. |
| **EC4 — exit** | Journey step: the owner and Colin open the same NC; Colin changes the title and saves; the owner changes the severity and saves (both kept, note shown); both change the description (the owner's dialog, keep mine). Live guardrails and advisors, exit report, `CLAUDE.md`. |

A migration is needed (EC1) and must be applied before the API (EC2) is pushed: until then a save that sends `version` would set a setting nothing reads, which is harmless, but the conflict details function would be missing.

## 6. Not in this plan

Live editing together, seeing others on the page (EC-D6), pushing other people's changes to an open screen, locking a record while someone edits it (check-out), merging rich text, conflicts on lifecycle actions (already refused by the database).

## 7. EC3 as built

**One shared layer, not per screen.** `apiFetch` hands any PATCH or PUT whose body carries `rowVersion` to `src/lib/editConflicts.js` (`versionedSave`):

- **Saves of one record run one at a time**, and each of the person's own saves is remembered (version saved on → version produced). A later save that was based on a version the person has since moved on themselves (autosave, two quick edits before a refetch) is sent on the newer one, so nobody clashes with themselves.
- **409 `edit_conflict`, no field in common** (fields named in the details against the keys of the body, `ownerId` ≈ `owner`) → saved again on the new version, then a note: "Colin Brown also changed Severity; both changes kept." (event `qms:edit-merged`, shown as an info toast by `EditConflictHost`).
- **A field in common** → the record is read again (GET of the path up to its id); a field that now holds the same value is not a clash, nor is one only this person changed (another tab). What is left goes to the dialog **`ui/EditConflictDialog.jsx`** (registered once in `main.jsx` by `EditConflictHost`): theirs and yours per field in words (ids named from anything already loaded on screen; rich text as its words), **Keep yours / Take theirs** (rich text: **Overwrite with mine / Load theirs**, with Copy your text). Save writes what was kept on the new version; taking everything of theirs writes nothing and answers with the record as it is (`tookTheirs(answer)`); **Cancel leaves the typing unsaved** (error "Not saved: …", `cancelled`).
- No version, or no dialog mounted → as before.

**What the screens send** (helpers in `editConflicts.js` and `hooks/useEditBase.js`):

| Helper | Use |
|---|---|
| `withVersion(record, body)` | a form that resets to the record when it refetches (NC page, gauge, part details, calibration record, audit record quick edits, employee active switch) |
| `changesSince(opened, body)` | a dialog that sends every field: only fields that differ from the record **as the dialog opened it** (`const [opened] = useState(record)`), plus its version; nothing comparable changed → the whole body |
| `useEditBase(record, dirty)` | a form with its own state that does not reset: the version follows the record until the person starts changing something, then stays (8D D0, reason cards, workflow rules) |
| own base ref + `tookTheirs` | autosaved rich text: document drafts (`useSaveDraft` exposes `reloads`; the editor's key changes so it starts again from the saved text) and review minutes |

Screens done: NC page; 8D D0, D2 5W2H, reason cards (D3, D7); risk dialog; document details, draft text and change summary; management review plan dialog and minutes; quality objective dialog; audit form; audit findings; audit record date and notes; quality alert drafts; control plan revision drafts; supplier (supplier quality) and SCAR edit; part details; part family, machine, employee, customer / supplier, gauge type, production order and lot dialogs; gauge page; calibration record; workflow rules.

**API addition (no migration): `@VersionedRows(table, key?)`** on a GET answering several records puts `rowVersion` on every row in one query (`rowsOf`: `data`, `items`, an array, or `key`), so dialogs opened from a register row have a version: machines, part families, employees, customers / suppliers, production orders, lots, gauge types, and a control plan's `revisions`.

**Not covered (no versioned route behind them):** the More details custom fields card (`custom_field_values`), management review inputs, job details, NC containment / disposition rows, actions, contacts and other child lines (EC-D5's "then the remaining edit dialogs"). Tests: `lib/editConflicts.test.js`, `hooks/useEditBase.test.js`, `ui/EditConflictDialog.test.jsx`, `lib/api-client.test.js`, `api/src/common/versioned.spec.ts`, `api/test/edit-conflicts.e2e-spec.ts` (rows).
