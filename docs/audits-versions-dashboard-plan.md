# Audits — versioned audit templates and the audits dashboard (plan)

**Status:** built and committed locally (AV1–AV3, AD1–AD2); the migration is **not applied live yet**. Requested 2026-11-08 ("make an audits dashboard. introduce versioned audit templates and record which version records were done against. require a reason and keep a history"). Decisions V1–V8 and D1–D4 are mine, taken as sensible defaults so the work could start; each is listed so it can be changed. Builds on `docs/audits-plan.md` (A5: "no revision workflow now") and the gap analysis phases C (templates and versions) and E (dashboard), taking only what was asked.

## 1. Today

An audit (`audit_definitions`, `AUD-001`) is edited in place. The checklist (`audit_questions`) and the "relevant to" list (`audit_targets`) are replaced as a whole. A record freezes a copy of the title, type, procedure, pass mark and questions when it is started, but **nothing says which edit of the audit that was, why the audit changed, or what it looked like before**; the audit trail (`audit.events`) holds raw row changes, not a readable history. The audits area has a schedule with a few counts but no dashboard.

## 2. Versioned templates

### What a version is
A **version** is an immutable, numbered snapshot of what a record freezes: **title, audit type, purpose, procedure, pass mark, the checklist (every question with its type, limits, options, rating scale, critical flag) and the "relevant to" list (machines, operations, departments)**. Version 1 is made when the audit is created (reason "First version"). **Every later change to any of that is a new version and needs a written reason** (1–1000 characters). The history is permanent: a version is never edited or deleted.

| # | Decision | Why |
|---|---|---|
| V1 | The schedule (frequency, first due date, grace days, weekdays only), the expected auditor, and retiring / reactivating are **not** versioned. They change how often and by whom, not what is checked. They stay in the audit trail, and retiring already needs a reason. | A record does not freeze them. Versioning them would make a new version for a rescheduled audit. |
| V2 | **A saved change is the current version at once.** There is no draft / published / archived stage. | Not asked for; the existing rule is "edit freely, audited". A publish workflow with approval belongs with the audit workflow phase (B) and is left out. |
| V3 | **The database enforces it**, not just the screen: a change to the content by a signed-in user that is not recorded as a new version with a reason is refused when the transaction ends. Changes made outside the app (SQL, tests, fixtures) are not blocked, but the next time the audit is started the difference is recorded as a version with a stated system reason, so a record's version always matches what it froze. | A rule that only the form enforces is not a rule. |
| V4 | A change that alters nothing (same content) is refused ("nothing has changed"), so the history has no empty versions. | |
| V5 | **A record keeps the version it was started against**, and the version number and a link to it are stored on the record (`audit_version_id`, `audit_version`). Editing the audit afterwards never changes a record or a record in progress (the frozen copy is unchanged from today). The record page says "Done against version 2 (the audit is now at version 4)" and links to the history. | The point of the request. |
| V6 | **Existing audits and records.** Each existing audit gets version 1 from its current content, reason "Existing audit, before versions were kept". An existing record is linked to version 1 **only when its frozen copy equals version 1**; otherwise it is left with no version and shown as "before versions were kept". Nothing is guessed. | Honest history. |
| V7 | **Compare.** Any version can be opened and compared with the one before it: header fields that changed, questions added, removed or changed (by position and text), and what-it-is-relevant-to added or removed. | A history nobody can read is not a history. |
| V8 | The UI keeps the word *audit*; the audit is the template. "Version 3" appears on the audit, in the registers and on every record. | No rename that touches every screen. |

### Data (new tables: RLS, `organisation_id`, audit trigger, no deletes, no user writes — guardrails and both sweeps)
- `audit_versions`: audit, version number, **reason**, content hash, the header content, who and when. Unique per audit and number.
- `audit_version_questions`: a copy of the question columns of the version.
- `audit_version_targets`: the machines / operations / departments of the version, with the label kept.
- `audit_records.audit_version_id`, `audit_records.audit_version` (nullable for records before versions).
- Functions (all `SECURITY DEFINER`): `app.audit_content_hash(audit)`, `app.save_audit_version(audit, reason)` (`audits.manage`; reason required from version 2; refuses no change), `app.ensure_audit_version(audit)` (used by start: creates version 1 or a "changed outside the app" version when needed), a deferred constraint trigger on the three content tables enforcing V3, a changed `app.start_audit`. Event `audit.version_saved`. Errors `QM018` → `409 audit_rule`.

### API
`PATCH /audits/{id}` and `POST /audits` take the content as now; a change to the content needs `changeReason`. `GET /audits/{id}/versions` (the history, newest first, with reason, who, when, a short summary of what changed and how many records were done against it), `GET /audits/{id}/versions/{n}` (the whole version and what changed from the previous one). Records and register rows carry `version`; `GET /audit-records` filters by `version`.

### UI
- The audit form (edit) asks for **"Why is this changing?"**, required once the content differs from what was loaded, with the version it will become ("Saved as version 4").
- The audit page: current version badge and a **Version history** card (version, date, who, reason, summary of changes, records done against it); a version opens in a dialog with the comparison.
- Records: **Version** on the record page (with the note above), a Version column and filter on the records register, the version on the schedule's record link where there is room.

## 3. The audits dashboard

`/Documentation/Audit-Dashboard` (menu "Audit dashboard", first under the audits entries), `audits.read`, no migration. One period selector (last 30 / 90 days, 12 months, year to date; URL `?period=`).

| # | Decision | |
|---|---|---|
| D1 | **Planned versus done.** For the slots due in the period: done on time, done late, missed, skipped, still to come, with the completion rate and on-time rate worked out as the schedule already does (state logic shared, not copied). | |
| D2 | **Results.** Audits done per week or month split pass / fail, pass rate, average score, against the previous period. | |
| D3 | **Findings.** Open, overdue (past due date), raised in the period, by classification, by status; those that became a non-conformance. Needs `audits.read` (findings share it). | |
| D4 | **Where it goes wrong.** The questions that fail most often (across completed records in the period), and **coverage**: for every machine, operation and department that any audit lists, when it was last covered by a completed audit and how long ago (stalest first). A listed item never covered is shown as "never". | |

Also: lists of overdue and missed audits, latest failed audits, open findings past their due date, and **recent changes to audit templates** (version, audit, reason, who) so the history is visible at a glance. KPIs link to the filtered registers.

## 4. Slices (each complete and tested)

- **AV1 — database:** the migration, backfill, functions, enforcement; SQL tests (mutation-checked); guardrails and tenancy sweep seeds.
- **AV2 — API:** versions endpoints, save with reason, record version, filter; e2e, sweep, mutation checks of the diff and the rules.
- **AV3 — UI:** reason on the form, history card, comparison, version on records; component tests.
- **AD1 — dashboard API:** `GET /audits-dashboard`; e2e and sweep.
- **AD2 — dashboard UI:** page, menu, links; component tests.
- **AX — exit check:** browser journey steps, docs, full suite. **Applying the migration live and pushing wait for your word.**

## 5. Not built (and why)

Draft / publish / archive of versions and approval of a change (needs the audit workflow phase), versioning the schedule, restoring an old version as the new current one (a new change with a reason does the same by hand), per-section structure of templates, a template library separate from audits.

## 6. Built and checked (2026-11-08)

- **Database** `supabase/migrations/20251219100000_audit_versions.sql` (**not applied live yet**; apply it before the API that uses it is deployed): the three version tables, `audit_records.audit_version_id/audit_version`, the functions and the deferred enforcement. `supabase/tests/audit_versions.test.sql` (with the fixture that gives an existing audit and three records to the backfill) passes; 24 mutants of the migration were tried and all are caught except one equivalent (the question order inside the fingerprint, which the sequence numbers already carry). Guardrails and both tenancy sweeps include the new tables.
- **API** `api/src/audits/audit-versions.*`, `audits-dashboard.ts`: unit tests of the comparison (10), e2e `audit-versions` (14) and `audits-dashboard` (16), the sweep covers the new routes; 36 API mutants were tried and all are caught (one build-failure catch counted).
- **UI**: `AuditVersions.jsx`, reason on `AuditForm.jsx`, version on the record page and both registers, `AuditsDashboard.jsx`; component tests for each, mutation-checked (all caught after three tests were added for survivors).
- **Browser journey** (`npm run journey`, throwaway database, fake Supabase and Stripe): the audit is changed, the form asks why, the history shows version 2 with the reason and the comparison, the record shows "version 1 (the audit is now at version 2)", and the dashboard shows the figures, coverage and the change. Screenshots 64–66 were looked at.
- **Whole suite**: lint 0 errors, 902 frontend tests, 165 API unit tests, 62 SQL test files (`npm run db:check`), 596 API end-to-end tests, build.

Not checked: the live project (the migration has not been applied, so the live guardrails check and advisors were not run for it), a non-throwaway database with real data, and the dashboard on a phone-width screen.
