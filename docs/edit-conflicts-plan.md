# Edit conflicts — plan

**Status:** proposed 2026-11-17 · decisions EC-D1–EC-D6 to agree · slices EC1–EC4

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

1. **Version on every editable record.** Responses carry `version` = `updated_at` as whole microseconds since 1970, as text (`app.row_version(updated_at)`). Nothing new is stored.
2. **A save says what it was based on.** A PATCH body may carry `version` (or the request an `If-Match` header). The API sets it for the transaction (`app.expected_versions`, `{ "<table>:<id>": "<version>" }`).
3. **The database checks it, in the update.** `app.touch_updated()` (replaced) looks for its row in `app.expected_versions`; when the row's current version differs it raises `QM031` naming the row; when it matches it removes the entry, so further updates of the same row in the same request (stage recomputes, triggers) are not mistaken for conflicts. Because the check runs inside the update, which holds the row lock, two saves can never both pass. It works the same for updates under RLS and inside SECURITY DEFINER functions.
4. **The API answers `409 edit_conflict`** with what changed since your version: `{ version, changedBy, changedAt, fields: [...] }`, taken from `audit.events` by `app.edit_conflict_details(table, id, since_version)` (only for a row the caller has just read under its own RLS in the same request; field names, who and when — values come from the record the caller may read).
5. **The screen decides what to do** (EC-D3):
   - **Nothing you changed was changed by them** → save again on the new version without asking, then say "Colin also changed Severity; both changes kept."
   - **A field you changed was changed by them** → a dialog per clashing field: their value, your value, **Keep mine** / **Take theirs**; then save on the new version. Cancel leaves your typing on screen, unsaved.
   - **Rich text** (document drafts, review minutes) cannot be merged field by field: "Colin saved this draft at 10:42. **Load theirs** (your text is kept in a copy you can paste from) / **Overwrite with mine**."
6. A save **without** `version` behaves as today (last write wins): imports, scripts, the worker, older clients.

## 4. Decisions to agree

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
| **EC2 — API** | `version` on the in-scope responses; PATCH bodies (and `If-Match`) take it; `DatabaseService.asUser` sets `app.expected_versions`; `QM031` → `409 edit_conflict` with the details; field names mapped back to the API's names (snake → camel, with a small table for the exceptions). e2e: two people on one record per route in scope (different fields → both kept; same field → 409 with the right details; no version → last write wins). Tenancy sweep unchanged (the body field is optional). |
| **EC3 — screens** | `apiFetch` / a shared `useVersionedSave` that sends `version`, retries a non-clashing conflict once on the new version, and raises the clash dialog (`ui/EditConflictDialog.jsx`) otherwise; the rich-text choice for document drafts and review minutes; optimistic quick edits (custom fields card, review inputs, job details) roll back and show the clash instead of a generic error. Tests per screen in scope. |
| **EC4 — exit** | Journey step: the owner and Colin open the same NC; Colin changes the title and saves; the owner changes the severity and saves (both kept, note shown); both change the description (the owner's dialog, keep mine). Live guardrails and advisors, exit report, `CLAUDE.md`. |

A migration is needed (EC1) and must be applied before the API (EC2) is pushed: until then a save that sends `version` would set a setting nothing reads, which is harmless, but the conflict details function would be missing.

## 6. Not in this plan

Live editing together, seeing others on the page (EC-D6), pushing other people's changes to an open screen, locking a record while someone edits it (check-out), merging rich text, conflicts on lifecycle actions (already refused by the database).
