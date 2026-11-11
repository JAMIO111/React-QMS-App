# Competence module — exit report

**Date:** 2026-11-11 · **Plan:** `docs/competence-plan.md` · **Slices:** CO1–CO5 · **Branch:** `Dev`

## What was built

Who is competent at what, and how that was established. **Information only: nothing here blocks work** (decision CP3).

- **Set-up (CO1):** categories (seeded), skills (code, refresh interval, retired with a reason), positions and what each requires (skill + level 1–4).
- **People (CO2):** positions held with dates (ended, never overwritten), append-only assessments on a fixed 0–4 scale (never your own, level 4 needs `competence.manage`, expiry from the skill's refresh interval), gap, expiry and standing **worked out on read**, the skills matrix, the person page and My competence.
- **Training (CO3):** one session with an attendee list, each attendee completed on their own day; a recorded result is corrected by voiding it; files on a session or on one attendee; training creates no assessment.
- **Dashboard and notice (CO4):** the dashboard at `/Competence`, the matrix as a CSV report, and an in-app notice to the person assessed (their linked sign-in only).
- **Exit check (CO5):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260130100000`, 93 SQL tests incl. `competence_core`, `competence_assessments`, `competence_training`, `competence_notice`, guardrails, tenancy sweep) | pass |
| `npm run api:test` (317) and `api:test:e2e` (75 suites, 882 tests incl. `competence`, `competence-people`, `competence-training`, `competence-dashboard` and the API tenancy sweep for every new route) | pass; `integration-schedule` fails in some full runs under load and passes alone (a known, unrelated flake) |
| `npm test` (1,327 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql`, run against the live project) | **0 violations**; the "must be audited" rule now lists the ten Competence tables |
| Live objects | 10 `competence_*` tables, 38 `app` functions, the private `competence-files` bucket, `notification_event_types.own_record` and the `competence_assessments.created` event type are present |
| Advisors (security) | no finding about Competence. The two warnings are project-wide: every table is visible to GraphQL (184 objects) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | INFO only: foreign keys without a covering index (the audit-column ones, like every other module) and indexes not yet used (the tables are new). Nothing needed |
| Browser journey (`npm run journey`, real app + real API + migrated database) | the new step passes: a skill and a position set up in Settings; Ada given the position and assessed one level short; a training session created, Ada completed and the session closed; the dashboard and the matrix show the gap; the matrix exports a CSV; Ada's own sign-in (no Competence permission) is taken to My competence, sees only her record and was sent exactly one "you were assessed" notice |

## What the browser found

The first run of the new journey step found a real bug no test had: opening `/Competence` directly sent the owner to **My competence**, because the dashboard decided "no permission" before the permissions had loaded. Fixed (it now waits for them; test added). The screenshots also showed the pages other than the dashboard had **no outer padding**; fixed on all of them.

## Rules held by the database (not only the screens)

An assessment is never changed or deleted (a trigger holds it for SQL too); you cannot assess yourself; a lower level needs a reason; training dates are the person's own and never in the future; a recorded result is frozen and only voided with a reason; closed and cancelled sessions cannot be changed; files are never deleted. Reading: `competence.read` (Controller-seat holders too), or your own record and the sessions you are on.

## Design notes and limits

- **No worker.** Expiry, gaps and standing are computed on read; nothing reminds anyone and there is no email or push (the only notice is the in-app one to the person assessed).
- **Expiry never lowers a level.** An expired assessment is flagged, not changed.
- The matrix shows at most 40 skills and 1,000 people (it says so and asks for a filter); the dashboard and matrix were tested for correctness, **not load-tested**.
- Department managers do not see their own department yet (CP11, CP17: give such people a role carrying `competence.read`, which shows everyone).
- Evidence files on an **assessment** are not built (only on a session or an attendee).
- No notices to attendees, no session calendar, no import of skills or assessments.
- Competence is **not subscription-gated** (no feature maps `competence.*`), like CAPA, audits and supplier quality.
- The live migration list (`supabase_migrations.schema_migrations`) does not show every migration the repository has (for example `20260127100000` and several earlier ones), although their objects exist. Worth reconciling by hand; it does not affect the app.
- `notification_event_types.own_record` changes who may see and switch off an event: it is used only by the Competence notice so far.

## Go-live runbook

Nothing to switch on. To use the module: an owner or quality manager adds skills and positions (Settings → Data Management → Competence), gives people positions on their page, and an assessor (`competence.assess`) records assessments. To let someone see their own record, link their sign-in to their employee record (Master Data → Employees, Controller-seat holders only).
