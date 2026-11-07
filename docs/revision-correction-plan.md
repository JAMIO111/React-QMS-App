# Correcting a released part revision — plan

**Status:** built (RC1 database, RC2 API, RC3 UI); migration `20251208100000_part_revision_corrections.sql` **not applied live yet** · **Builds on:** master data part revisions (2.1), process control resolver (PC3), inspections (PC4), operator hub

## 1. The problem

A released part revision is frozen (`app.part_revision_lifecycle`; its specification values are locked too). If the customer's drawing says one thing and the system
another, the only way to fix the system today is to create the next revision. That moves the system's letter away from the drawing's: the drawing is still "Rev B", the
system says "Rev C". Every later inspection, NC and certificate then quotes a revision that does not exist on the drawing.

## 2. Design: correction versions of the same revision

A revision letter belongs to the drawing. A **correction** keeps the letter and adds a **version**: "Rev B v2". The wrong record is kept, frozen, and marked as corrected.

- **Data** (one migration): `part_revisions.version` (default 1), `corrects_id` (the version it replaces), `correction_reason`, `corrected_at`; status gains `corrected`
  (a released version that was wrong; never deleted, never edited). The unique index becomes (part, letter, version); "one released per part" stays.
- **Start:** `app.start_part_revision_correction(revision, reason)`: needs `master_data.manage`, the revision must be the part's **current released** one, a reason is required,
  one open correction at a time. It creates draft "Rev B v2" with the same values, drawing reference and characteristics copied from v1. The draft is edited with the existing draft rules.
- **Approve and release:** `app.release_part_revision_correction(revision)`: needs **`process_control.approve`** (owner, admin, quality manager), (see §6 Q1 on whether the preparer may also approve).
  In one transaction v1 becomes `corrected` (frozen, with who/when/why) and v2 becomes `released`. The ordinary release path refuses a draft that has `corrects_id`.
  Event `part.revision.corrected` in the outbox; audited like every revision change.
- **What follows from it, with no extra code:** the resolver uses the one released row, so new inspections use v2's values. Existing inspections, NCs and control plan
  resolutions keep pointing at the exact v1 row they used, so what an operator measured against is never rewritten.
- **Impact list:** `GET /part-revisions/{id}/correction-impact`: inspections (reference, status, result, started, operator) and non-conformances that reference the
  corrected version, in progress ones first. Information and a prompt to review only: nothing is changed, raised or re-opened silently.
- **Running jobs:** a job still running on v1 gets the existing "a newer revision is in force" banner, worded for a correction ("corrected version v2").
- **Where it shows:** part page revision table lists every version (letter, v, status, reason); a draft correction shows "Correction of B v1: <reason>"; **Correct this
  revision** action on the current released row; Approve and release (approvers only, with the impact summary beside it); the impact card after release. Everywhere else
  keeps showing the letter only, with "v2" added where a corrected version is current.

## 3. Decisions (agreed)

1. **Correction versions** (not edit-in-place, not a separate drawing-revision field).
2. **Approvers only** release a correction, and the **impact list** is shown after release.
3. **The same person may prepare and approve** a correction (small teams); the audit trail records who did each.
4. **Older, already-replaced revisions are not correctable** in this version.

## 4. Slices

- **RC1 — database.** Migration, functions, triggers, SQL tests (rules, frozen v1, one open correction, resolver picks v2, old inspections keep v1), guardrails.
- **RC2 — API.** `POST /part-revisions/{id}/correction`, `POST /part-revisions/{id}/release` routed for corrections, `GET /part-revisions/{id}/correction-impact`; e2e, tenancy sweep, mutation checks.
- **RC3 — UI.** Revision table, correction dialog and draft banner, approve and release, impact card, job-hub banner wording; unit tests; journey step with screenshots; docs, CLAUDE.md.

## 5. Not in scope

Correcting a revision that is already superseded by a later letter (the drawing's older revision), edit-in-place, automatic re-inspection or NC raising, uploading the drawing
file itself, a separate "drawing revision" field.


## 7. Built, and how it was checked

- **RC1** `supabase/migrations/20251208100000_part_revision_corrections.sql`, `supabase/tests/part_revision_correction.test.sql` (in `npm run db:check`, all 51 files pass). Mutation checks: the ordinary release path,
  the approval right, marking corrected directly, correcting a non-released revision and a stale correction each make the test fail.
- **RC2** `POST /part-revisions/{id}/correction`, `GET /part-revisions/{id}/correction-impact`, release routed to `app.release_part_revision_correction` for a correction, version fields on revisions, `currentVersion` on parts,
  `version` on the job hub's revisions; `api/test/part-revision-corrections.e2e-spec.ts` (13 tests), tenancy sweep; all 436 e2e tests pass.
- **RC3** part page (revision table with versions, Correct, Approve and release, Discard, impact card), spec values picker, parts registers, job hub banner and Revisions pane; 13 new unit tests; browser journey step (screenshots `30`–`33`).
- The browser showed two flaws, both fixed: a released correction still offered "Discard", and the specification values picker did not show the version.
- **Limits:** the impact card lists the latest corrected version only; lists are capped at 50 with the total shown; the impact is read from the records' revision links, so inspections created before this change are on v1 (as they should be);
  customer-facing documents (certificates, reports) that print a revision show the letter only; no email or notification is sent when a correction is released.
