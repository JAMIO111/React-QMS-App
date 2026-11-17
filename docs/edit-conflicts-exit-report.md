# Edit conflicts — exit report (EC4)

**Date:** 2026-11-17 · **Plan:** `docs/edit-conflicts-plan.md` (decisions EC-D1–EC-D6) · **Slices:** EC1 database, EC2 API, EC3 screens, EC4 this check.

## 1. What was built

Two people can no longer silently overwrite each other's edits on the same record.

| Slice | What | Where |
|---|---|---|
| EC1 | The version of a row is `updated_at` to the microsecond (`app.row_version`). A save may name the version it was based on (`app.expected_versions`); `app.touch_updated()` refuses the update inside the row lock when the row changed since (`QM031`), the same for updates under RLS and inside SECURITY DEFINER functions; `app.edit_conflict_details` says what changed since, who and when, from the audit trail. | migration `20260324100000_edit_conflicts.sql` (applied live 2026-11-17) |
| EC2 | `@Versioned(table)` on a record's GET and PATCH/PUT: answers carry `rowVersion` (in the body; the `ETag` was removed in EC4, §3); saves send `rowVersion` (or `If-Match`); a refused save answers `409 edit_conflict` with `{ version, changedAt, changedBy, fields, people }`. | `api/src/common/versioned.ts` |
| EC3 | `apiFetch` handles every versioned save in one place (`lib/editConflicts.js`): saves of one record in turn, the person's own saves never clash, other people's changes to other fields are kept with a note, a clash on the same field opens `ui/EditConflictDialog.jsx`. Screens send their version (`withVersion`, `changesSince`, `useEditBase`, autosave base refs). `@VersionedRows` gives register rows a version for dialogs opened from a row. | plan §7 |
| EC4 | Browser journey step, live checks, this report. | `scripts/journey/journey.cjs` `editConflicts()` |

## 2. Evidence

| Check | Result |
|---|---|
| SQL test `supabase/tests/edit_conflicts.test.sql` (RLS update and SECURITY DEFINER update refused on a stale version, second update of the same row in one request not a conflict, no setting = last write wins, details, other organisation `P0002`, anon cannot execute) | passes in `npm run db:check` |
| API e2e `api/test/edit-conflicts.e2e-spec.ts` (version on GET and never as the ETag, first save passes, second on the same version refused with the right fields and person, save again on the new version passes, If-Match, no version = last write wins, malformed version ignored, risk saved through a database function, outsider learns nothing, register rows carry versions) | passes; full API e2e 1160 passed, 1 skipped |
| Frontend tests (`lib/editConflicts.test.js`, `hooks/useEditBase.test.js`, `ui/EditConflictDialog.test.jsx`, `lib/api-client.test.js`) | pass; full suite 1671 passed |
| Browser journey `editConflicts()` | **passes**, and the whole `npm run journey` passes (the two `409 edit_conflict` answers the step provokes are on the journey's list of expected answers) |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project) | **0 violations**; the four EC1 functions present, `touch_updated` checks versions, both `check_edit_version` triggers in place |
| Live security advisors | nothing new: the two standing notices only (GraphQL lists tables to signed-in users; leaked-password protection is off, M5 in `docs/audit-2026-11.md`) |

## 3. The journey step

The owner and Colin (in two browsers) open the same draft non-conformance.

1. Colin changes the title and saves.
2. The owner, still on the version they opened, changes the severity and saves: the save goes through on the new version, the note says "Colin … also changed Title; both changes kept.", the database holds Colin's title and the owner's severity, and the owner's page shows Colin's title.
3. Both reload; Colin changes the description and saves; the owner changes the description too and saves: the **Changed while you were editing** dialog shows Colin's text as theirs and the owner's as yours; the owner keeps theirs; the note says the choice was saved, and the database holds the owner's description with Colin's title and the owner's severity.

Screenshots: `ec-merged-note`, `ec-clash-dialog` (in `JOURNEY_OUT`, default `/tmp/journey`).

**Found by the browser and fixed:** EC2 sent the record's version as the HTTP `ETag`. An answer also holds child rows (a part's revisions) that change without moving the record's own version, so the browser revalidated with `If-None-Match`, got `304 Not Modified` and kept its old copy: in the journey a part's revision correction was saved but never appeared on the page (an earlier step, not the new one). The version now travels in the body only (`If-Match` on a save is still accepted); `edit-conflicts.e2e-spec.ts` checks the ETag is not the version. **Not yet checked by eye:** in the clash-dialog screenshot the Keep yours / Take theirs switch is caught with its highlight still sliding in.

## 4. Limits and what is not built

- **Not covered by a version check** (the last save wins, as before): the More details custom fields card, management review input sections, job details, and child lines (8D and risk actions, contacts, NC containment actions and dispositions, cost lines). Lifecycle steps (approve, complete, issue, close…) were already safe: the database refuses a second caller.
- **No presence** ("Colin is viewing", EC-D6) and nothing pushes another person's change to an open screen; a person learns of it when they save.
- **Rich text is not merged**: the person chooses theirs or yours for the whole text, with their own text to copy.
- A form that keeps its own state and is changed again after taking the other person's value asks again on the next save (safe, not silent).
- A record saved by a route without `@Versioned` (a command such as a stage change) moves the version; a form still open on the old version then goes through the merge-or-ask path on its next save, which is the intended behaviour.

## 5. Conclusion

The edit conflicts plan is complete.
