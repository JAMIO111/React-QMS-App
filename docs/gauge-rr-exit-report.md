# Gauge R&R (measurement system analysis) — exit report

**Date:** 2026-11-24 · **Plan:** `docs/gauge-rr-plan.md` · **Slices:** MS1–MS6 · **Branch:** `Dev` (local commits, not pushed)

## What was built

"Can this gauge, used by these people, be trusted to measure this characteristic?" under **Calibration → Gauge R&R**. **Information only** (decision D2): a poor result never changes a gauge, never blocks recording and never raises anything by itself.

- **The statistics (MS1, `api/src/msa/`):** crossed gauge R&R (ANOVA and average-and-range), Type 1 (bias, Cg / Cgk) and attribute agreement (kappa, effectiveness, miss and false-alarm rates), as pure functions with a version (`msa-1`) and the criteria used (`aiag-msa-4`) recorded in every result.
- **The data (MS2, migration `20260428100000_gauge_rr.sql`, applied live):** studies, appraisers (Employees register or a typed name), parts, one measurement row per cell (a random run order made when collecting starts) and a frozen result with a SHA-256 of the exact data. Every write is a function; completing is API-login only and refused unless the data hashes to what the API analysed.
- **The API (MS3):** studies, readings (grid or pasted), live analysis, completion, report, repeat, the gauge's card.
- **The screens (MS4):** register, study page with the run sheet and paste dialog, analysis with charts, printable report, the gauge page card.
- **Coverage and the rest (MS5, migration `20260429100000_gauge_rr_workflow_reminders.sql`, **not yet applied live**):** `GET /msa/coverage` and the Coverage view, a badge on each critical or major characteristic of a control plan in force, the workflow trigger `msa.study.completed`, and a reminders area for gauge custodians.
- **The exit check (MS6):** this report, the live checks, and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run lint` (frontend) | 0 errors (warnings as before) |
| `npm test` | pass: 199 files, 2,092 tests |
| `npm run build` | pass |
| `npm run db:check` (all migrations incl. `20260429100000`, every SQL test incl. `gauge_rr`, `gauge_rr_workflow_reminders`, guardrails, tenancy sweep) | pass: 171 SQL tests |
| `npm run api:test` / `api:test:e2e` (incl. `msa`, `msa-coverage`, `workflows`, `reminders`, both tenancy sweeps) | pass: 55 unit suites (572 tests); 128 e2e suites (1,396 tests, one skipped suite that was skipped before) |
| Live guardrails (the rules that apply to the five `msa_*` tables, run read-only against the live project: RLS and a SELECT policy, tenant-owned, no anon privilege, no truncate, search path, audit trigger) | **0 violations**. This was the subset for the new objects and the shared rules (1, 4, 5, 6, 7 and, for the MSA tables, 2 and 8), not the whole `guardrails.sql` file |
| Live objects | the five `msa_*` tables and 18 `app` functions are there, the history table has the `20260428100000 gauge_rr` row. **The MS5 migration is not applied yet**: live still has 21 workflow triggers and 12 reminder areas |
| Advisors (security, read as the whole list) | two findings, both project-wide and unchanged since earlier exit checks: every table is visible to GraphQL, and **leaked-password protection is off** (a Supabase dashboard setting). Nothing names an MSA object |
| Advisors (performance) | not re-read this time |
| Browser journey (`npm run journey`, real app, real API, migrated database) | **passes**, with the new Gauge R&R step. It took six runs to get there: two runs failed on the audit-note bug, one on a mistake in my own step, and two on the plan-characteristic bug (details below); the sixth passed from the first step to the last |

## What the browser found

Three real faults, none of which a test had caught. Both are fixed and each has a test that fails without the fix.

1. **A note typed straight after choosing Fail was wiped** (found at the audit step, which runs long before the Gauge R&R one). An answer is shown at once with a placeholder id; when the server confirms it the placeholder is replaced by the real id, and the question took that for "the server's answer changed" and put the (still empty) saved note back over the words being typed. The question now follows the server only when the answer's value or note changes, not its id (`AuditRecordPage.jsx`, test in `AuditRecords.test.jsx`). On a slow connection a person could have lost a sentence.
2. **Plan a study from a coverage row left the plan's limits empty.** The row knew the characteristic but not its nominal, limits or unit, so for a characteristic whose values come from the control plan (not the part) the form opened with the gauge and name filled in and the limits blank. The coverage row now carries nominal, both limits and the unit and the form starts with them (`msa.service.ts`, `studyDefaultsFor`; e2e and component tests).

3. **Planning a study for a characteristic written on the control plan was refused.** When a study names a part and a characteristic key, the API looked the key up only among the part's own released values, so a characteristic whose limits live on the control plan (the usual case) answered `400 unknown_characteristic` and **Plan a study** from coverage could not save. The key is now also looked up on an effective revision of an active plan that covers the part, whether the plan is written for the part's family or for that one part (a key found nowhere is still refused). The first version of this fix missed the single-part scope, which the next journey run caught, and the plan's name, unit and limits fill what the person did not give (`msa.service.ts` `characteristicDefaults`, e2e test in `msa-coverage.e2e-spec.ts`). Found only because the journey clicked through the whole path; the unit and component tests had mocked the server.

The journey step (`gaugeRR()` in `scripts/journey/journey.cjs`) also had two mistakes of its own, found by running it: it used a Testing Library query in a Playwright script, and it counted a column that is called `value`, not `value_text`.

## What the journey step covers

A critical diameter is measured with a micrometer nobody has studied → coverage says **No study** → **Plan a study** from that row with the kind, gauge, characteristic and the plan's limits already in the form → plan a crossed study (3 parts, 2 appraisers, 2 trials) → start collecting → paste the twelve readings → record them → complete with a conclusion → the database holds a frozen result (`msa-1`, a 64-character fingerprint, verdict acceptable) → the report page → coverage now says **Acceptable** and no longer lists it under "needs attention" → the control plan page shows the badge → the gauge page lists the study.

It does **not** cover: Type 1 or attribute studies in the browser (covered by component and API tests), the workflow trigger firing, the reminders area, a viewer without `calibration.manage`, or a phone.

## Rules held by the database (not only the screens)

A completed study cannot be changed (a trigger holds it, for SQL too); its design is locked once collecting starts; readings are never deleted or cleared, only overwritten while collecting (and audited); a result cannot be frozen for data the database does not hold (the hash is checked); a study cannot be completed with an empty cell; everything is checked per site through the gauge. Expiry (12 months by default) is worked out on read and changes nothing.

## Design notes and limits

- **Not verified against a source** (plan §11): the attribute agreement bands against the AIAG manual's own table, and VDA 5 criteria. Everything else was checked against the AIAG MSA 4th edition worked example, statsmodels / scipy and a variance-recovery simulation. **Never change a formula without its spec; a result is frozen with its algorithm version.**
- **Coverage looks at readings with a recorded gauge in the last 12 months.** A characteristic measured with no gauge recorded is "No readings", not a gap in the study. A study that names a part counts only when that part was measured.
- **Coverage and the badge read through the caller's rights** (`process_control.read` and `inspection.read`; the badge also needs `calibration.read`). Someone without them is told why, never shown zeros.
- The reminders area tells the **custodian of the gauge**; it does not tell whoever completed the study.
- Not built: linearity and stability studies, files on a study, a notice when a study expires on its own, a one-click "apply" of a result to anything, configurable criteria.
- The study screens were checked in a browser at 375 px wide in MS4 with sample data; the journey runs at desktop width. Nothing has been tried with real appraisers or real production data.
- The MS5 migration only replaces shared functions from their live text with a checked patch, so applying it is low risk, but until it is applied live the trigger `msa.study.completed` and the reminders area do not exist there.

## Go-live runbook

1. Apply `supabase/migrations/20260429100000_gauge_rr_workflow_reminders.sql` live (SQL editor), then add its history row: `insert into supabase_migrations.schema_migrations (version, name) values ('20260429100000', 'gauge_rr_workflow_reminders');`
2. Push the code when told to (the API can go first: without the migration only the workflow trigger and the reminders area are missing).
3. Nothing to switch on. People who manage calibrations plan studies (Calibration → Gauge R&R → Plan a study, or from a row in Coverage); people who record calibrations enter readings.
