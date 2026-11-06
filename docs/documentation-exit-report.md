# Documentation module (quality alerts) — Exit Report

**Date:** 2026-11-06 · **Branch:** `Dev` · **Plan:** `docs/documentation-plan.md` (slices DOC0–DOC4) · **Brief:** `docs/design-brief.md` §11, §14

## Verdict

Quality alerts are complete as a vertical slice: department membership (DOC0), the alert record and its lifecycle (DOC1), recipients and
acknowledgement (DOC2), and where-work-happens, files and links (DOC3). Every decision D1–D9 in the plan is implemented, with the limitations
in §4. The database and API are verified by automated tests and, for the catalogue, on the live project. **The screens have not been checked in a
real browser** (see §4).

## 1. What was verified

| Area | Evidence |
|---|---|
| Database rules | `supabase/tests/department_members`, `quality_alerts`, `quality_alert_recipients`, `quality_alert_extras` (frozen content, one open draft, numbering, recipients fixed at issue, acknowledgement once and frozen, files and links draft-only, storage rules, isolation between organisations) |
| Tenancy | `guardrails.test.sql` (all new tables audited, RLS, no anon privileges, fixed `search_path`), `tenancy_sweep.test.sql` (every new table seeded), API sweep (every new route scoped; foreign ids answer 404; no list leaks) |
| API | `api/test/quality-alerts`, `quality-alert-recipients`, `quality-alert-extras` e2e suites (265 e2e tests and 136 unit tests pass) |
| UI | component tests for register, alert page, editor, My alerts, acknowledgement, banner, links and files (313 frontend tests pass) |
| Live project | all migrations through `20251120100000` applied and recorded; catalogue checks after each (RLS on, policies, triggers, grants, `search_path`, bucket) |
| Advisors (live) | security: no missing RLS, no function warnings (only project-wide GraphQL exposure and leaked-password protection, below); performance: five `auth_rls_initplan` warnings, fixed by `20251121100000_rls_initplan_wrap.sql` |

**Mutation checks (DOC3 guards).** Removing the draft-only rule on adding files, the draft-only rule on uploads into a folder, or the
draft-hides-files rule on reading each makes a test fail. Removing the organisation check on a link target does **not**: the composite foreign
key `(record id, organisation_id)` refuses a foreign record by itself, so that check is defence in depth.

## 2. Advisor findings

- **Fixed (needs applying):** `20251121100000_rls_initplan_wrap.sql` wraps `auth.uid()` as `(select auth.uid())` in five SELECT policies
  (`department_members`, `quality_alert_recipients`, `notifications`, `notification_preferences`, `notification_reads`). Same rules.
- **Left as it is, project-wide:** every table and view is listed as "visible in the GraphQL schema to signed-in users" (94 objects, all behind
  RLS). Revoking `SELECT` would break the client's direct Supabase reads; it is a decision for when all reads go through the API.
- **Dashboard setting:** leaked-password protection is off (Supabase Auth settings; not changeable from a migration).
- **INFO only:** unindexed foreign keys (mostly audit columns) and not-yet-used indexes, as before.

## 3. Definition of done (brief §14)

Tenancy, audit trail (all new tables carry `audit_changes`; lifecycle steps only through functions), permissions (`documentation.read/.manage/.issue`),
tests at database, API and UI level, documentation (`CLAUDE.md`, plan) and migrations applied to the live project are in place.

## 4. Limitations and not done

- **No browser check.** The screens were exercised only through component tests. The app needs a signed-in session against the live project, and no
  credentials were available in this environment. A walk through the editor (pickers, dates, files), the banner on the four pages and My alerts is still to do.
- **No worker.** Expiry runs when alerts are read or written; there are no automatic reminders for overdue acknowledgements and no email.
- **Department-scoped roles are still inert:** membership says who belongs where; `app.has_permission` is unchanged.
- **People with no department** receive an alert only by role or by name.
- **Files:** no virus scan; a removed file stays in storage as evidence; a revision points at the same stored files as the revision it copied.
- **Links:** a reader who cannot read a linked record sees "Not available to you" instead of its name.
- **Not gated by subscription package** (D5); can be added with the `modules` catalogue.
