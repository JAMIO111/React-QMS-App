# Competence module — plan

**Status:** draft for agreement (decisions CP1–CP4 taken 2026-11-11, the rest proposed) · **Branch:** `Dev`
**Menu name:** Competence · **Icon:** graduation cap (`GraduationCapIcon`, Lucide `GraduationCap`)

Per `docs/design-brief.md` §6.7 and Phase 4 ("Training and competency matrices"), this module records **who is competent at what**,
how that was established and when it must be checked again. It is built as complete, tested vertical slices (CO1–CO5) and, like quality
alerts and supplier quality, **informs and never blocks**. Nothing here is built yet.

## 1. What it is for

- A **skills matrix**: people × skills, each cell a level 0–4 with who signed it off, when, on what evidence, and when it expires.
- **Training records**: what training someone had, when, from whom, with the certificate or sign-in sheet attached, and which skills it
  supports. A training record is evidence; it does not by itself make anyone competent.
- **Positions**: the organisation says "a CMM inspector needs these skills at these levels"; the matrix then shows gaps against the
  positions each person holds.
- A **dashboard**: gaps against position, assessments expiring or expired, people with nothing recorded.

It is *not* a learning platform (no courses, quizzes, scheduled sessions or booking), not HR (no pay, appraisals or contracts) and it
decides nothing about who may do a task (see CP3).

## 2. Decisions

| # | Decision |
|---|---|
| CP1 | **First slice = matrix + training records** (skills, positions, assessments, training records, dashboard). No course catalogue or sessions. |
| CP2 | **The people are the Employees register** (Master Data → Employees), whether or not they have a sign-in. A person with a linked sign-in (`Employees.auth_id`) can see their own competence. |
| CP3 | **Information only.** Warnings are shown where work happens later (e.g. job hub: "not signed off for this operation"); nothing blocks. The data model leaves room for a future rule but builds none. |
| CP4 | **Fixed 0–4 scale:** 0 none, 1 learning, 2 supervised, 3 competent, 4 can train others. |
| CP5 | **Requirements come from positions.** A position lists skills with a required level (1–4); an employee holds one or more positions. A skill carries no minimum of its own. |
| CP6 | **Sign-off needs `competence.assess`; nobody assesses themselves** (refused when the assessor's sign-in is the employee's linked sign-in). **Level 4 needs `competence.manage`.** |
| CP7 | **Expiry per skill, computed on read.** A skill may set a refresh interval in months; an assessment's expiry defaults to its date plus that and may be set by hand. Expired assessments are listed and flagged, **never change the level automatically**, and need no worker (as supplier certificates). |
| CP8 | **Dashboard in the first slice.** |
| CP9 | Nothing is deleted. Skills and positions are retired with a reason; assessments are append-only (a new one supersedes); a training record is voided with a reason. |
| CP10 | Not subscription-gated in this slice (no feature mapped), like CAPA, audits and supplier quality. |

## 3. Data model (all tenant tables: `organisation_id`, RLS, audit trigger, no table writes except where stated)

| Table | Purpose |
|---|---|
| `competence_categories` | Per organisation, seeded (Inspection, Measurement, Machine operation, Quality system, Health and safety, Other); `competence.manage` adds, renames, switches off; key fixed, nothing deleted. |
| `competence_skills` | `code` (unique per organisation, any case), `name`, category, description, `refresh_months` (1–120, optional), active / retired with reason. |
| `competence_positions` | `code`, `name`, description, active / retired with reason. |
| `competence_position_skills` | Position ↔ skill with `required_level` 1–4; replaced as a whole by a function, history kept in the audit trail. |
| `competence_employee_positions` | Employee ↔ position with `started_on`, `ended_on`; ended, never deleted. |
| `competence_assessments` | **Append-only.** Employee, skill, `level` 0–4, `assessed_on` (not in the future, in the person's time zone), assessor, optional `expires_on`, note, `status` current / superseded, link to what it supersedes. Written only by `app.record_competence_assessment`. |
| `competence_training_records` | Employee, title, kind (course / on the job / external / induction / other), provider or trainer, `trained_on`, hours, outcome (passed / attended / failed), notes, skills it supports (`competence_training_skills`), status recorded / voided (reason). Written only by functions. |
| `competence_attachments` | Evidence files on an assessment or a training record; functions only, removed with a reason, never deleted; private `competence-files` bucket at `<org>/competence/<employee id>/<uuid>-<name>`, uploads via `app.competence_file_allowed`. |

**Worked out, never stored:** an employee's current level per skill (latest current assessment); required level (highest across the
positions they hold); gap (required minus level); expiry state (valid / expiring within 60 days / expired / none, reusing the supplier
expiry rules).

## 4. Rules in the database (functions are SECURITY DEFINER; errors `QM024` → `409 competence_rule`; other organisation `P0002` → 404)

- `app.record_competence_assessment(employee, skill, level, assessed_on, expires_on?, note?)`: needs `competence.assess`; refuses the
  employee's own linked sign-in; level 4 also needs `competence.manage`; a level of 1–4 on a retired skill is refused; supersedes the
  previous current assessment; expiry defaults from the skill's refresh interval; a note is required when the level goes **down**.
- `app.set_position_skills(position, jsonb)`, `app.assign_employee_position(employee, position, started_on)`,
  `app.end_employee_position(id, ended_on)`, `app.save_competence_skill / retire / reactivate`, `app.save_competence_position / retire /
  reactivate` (all `competence.manage`).
- `app.record_training(employee(s), …)`, `app.void_training(id, reason)` (`competence.assess`), evidence functions as for other modules.
- Inactive employees are left out of the matrix and dashboard by default; their history stays readable.

## 5. Permissions

`competence.read`, `competence.manage`, `competence.assess` (new, role defaults in the migration).

| Role | read | manage | assess |
|---|---|---|---|
| Owner, admin, quality manager | yes | yes | yes |
| Quality engineer | yes | no | yes |
| Inspector, viewer | no (own record only) | no | no |

**Every active member with a linked employee record can always see their own competence**, whatever their role (personal data: see
open question Q1). Site scoping is not applied in this slice (organisation-wide, like supplier quality).

## 6. API (`api/src/competence/`, everything through `DatabaseService.asUser`)

`GET|POST /competence/skills`, `PATCH /competence/skills/{id}`, `POST …/retire|reactivate`; same for `/competence/positions` plus
`PUT /competence/positions/{id}/skills`; `GET|POST /competence/categories`, `PATCH …/{id}`;
`GET /competence/matrix` (page-based: `positionId`, `departmentId`, `siteId`, `categoryId`, `skillId`, `status` gap|expiring|expired|all,
`q`, `page`, `pageSize`; cells carry level, required, gap, expiry, assessor, date), `GET /competence/people/{employeeId}` (profile: positions,
every skill with level, required, history, training records), `POST …/assessments`, `POST …/positions`, `POST /competence/positions-assignments/{id}/end`,
`GET|POST /competence/training-records` (one record for several employees creates one row each), `POST …/{id}/void`,
`GET|POST …/{id}/attachments`, `POST /competence/attachments/{id}/delete|restore`, `GET /competence-dashboard?from&to`, `GET /competence/me`
(own record, any member with a linked employee). New routes are `@OrganisationScoped` and get sample bodies in the tenancy sweep.

## 7. UI (`src/components/competence/`, hooks `useCompetence.js`, helpers `lib/competence.js`)

Menu group **Competence** (`GraduationCapIcon`, `/Competence`): **Dashboard** (default), **Matrix**, **Training records**, **My competence**
(shown to anyone with a linked employee record). Skills, positions and categories are set-up lists and live in
**Settings → Data Management → Competence** (a new tab with the same icon), as for the other modules.

- **Matrix** (`/Competence/Matrix`): the shared table pattern with sticky person column and one column per skill (grouped by category),
  level shown as a 0–4 dot scale and colour-safe badges (gap / expiring / expired carried by words and icons too), filters in the URL,
  CSV export, click a cell or person to open the profile.
- **Person profile** (`/Competence/People/:employeeId`): positions held, each skill with level, required, expiry and history, **Assess**
  dialog (skill combo, level, date, expiry, note, evidence), training records with files, link back to the Employees record.
- **Training records** register (`TableWrapper`, server paging, URL filters) with a record dialog (several employees at once, skills supported, files).
- **Dashboard** (`/Competence`, shared period picker): people with gaps, assessments expiring in 30/60/90 days, expired, nobody-assessed
  employees, training recorded in the period, lists of the worst gaps and next expiries.
- Optimistic saves for small edits, `CTAButton` / `RHFComboBox` / `RHFDatePickerPopout` / `Callout` / `DropdownMenu` as elsewhere, required
  fields marked, every mutation hook calls `refreshOrganisation`.

## 8. Slices

| Slice | Content |
|---|---|
| **CO1** | Migration: categories, skills, positions, position skills, permissions and role defaults, menu and Settings tab shell. API + Settings UI for categories, skills, positions. |
| **CO2** | Employee positions, assessments, current level and gap computed, matrix and person profile, My competence. |
| **CO3** | Training records, evidence files and the bucket, Training records register. |
| **CO4** | Dashboard, expiry lists, CSV export of the matrix, in-app notice to an employee when assessed (event `competence_assessments.created`, to the linked sign-in only). |
| **CO5** | Exit check: live guardrails, advisors, browser journey step, `docs/competence-exit-report.md`, `CLAUDE.md`. |

Each slice ships with SQL tests (rules above with deliberate mutants), API e2e (both sweeps), frontend tests and, as always, lint, build,
`npm run db:check` and the API suites before commit.

## 9. Out of scope (stated so it is not assumed)

Blocking or gating work on competence; a course catalogue, sessions, quizzes or e-learning; reminders by email or push (expiry is shown, not
pushed); scheduled worker; linking skills to machines or control-plan operations (the job hub warning is a later slice and would build on
CP5's positions); appraisals, pay or contracts; supplier or customer personnel; importing skills or assessments (a later integrations entity).

## 10. Open questions for you

1. **Who may see everyone's levels?** I proposed quality roles only; inspectors and viewers see only their own. Skill levels about named
   people are personal data. Do you want supervisors (department managers) to see their own department's people, which needs a
   department-scoped read?
2. **Group training:** is "one record per employee, created together" enough, or do you need a single session record with an attendee list?
3. **Position history:** keep dates on who held which position (proposed), or just the current positions?
4. **Seeding:** start empty, or seed a few example skills and positions (e.g. Visual inspection, CMM operation, Gauge handling) that the
   organisation can edit or retire?
