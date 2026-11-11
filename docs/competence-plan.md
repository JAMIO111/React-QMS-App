# Competence module — plan

**Status:** draft for agreement (decisions CP1–CP4 and CP11–CP14 taken 2026-11-11, the rest proposed) · **Branch:** `Dev`
**Menu name:** Competence · **Icon:** graduation cap (`GraduationCapIcon`, Lucide `GraduationCap`)

Per `docs/design-brief.md` §6.7 and Phase 4 ("Training and competency matrices"), this module records **who is competent at what**,
how that was established and when it must be checked again. It is built as complete, tested vertical slices (CO1–CO5) and, like quality
alerts and supplier quality, **informs and never blocks**. Nothing here is built yet.

## 1. What it is for

- A **skills matrix**: people × skills, each cell a level 0–4 with who signed it off, when, on what evidence, and when it expires.
- **Training sessions**: one session (what, who ran it, which skills it supports) with an **attendee list**; each attendee is marked
  completed on **their own day**, so one session can finish for different people on different days. Certificates and sign-in sheets are
  attached as evidence. Training is evidence; it does not by itself make anyone competent.
- **Positions**: the organisation says "a CMM inspector needs these skills at these levels"; the matrix then shows gaps against the
  positions each person holds.
- A **dashboard**: gaps against position, assessments expiring or expired, people with nothing recorded.

It is *not* a learning platform (no course catalogue, quizzes, calendar booking or e-learning), not HR (no pay, appraisals or contracts) and it
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
| CP11 | **Who sees what.** Anyone holding `competence.read` sees **everyone's** competence (given to owner, admin, quality manager, quality engineer, and to whatever "department management" role the organisation sets up with that permission); **Controller-seat holders see everything in the module** whatever their role. Seeing only your own department, and role-based narrowing, are **deferred** (to be designed later); until then there is no department-scoped read. |
| CP12 | **One training session, an attendee list, each attendee completed on their own date** (CP14 for the states). A session is not "done" on one day. |
| CP13 | **Dates are kept as history**: positions have `started_on` / `ended_on` and are ended, never overwritten. |
| CP14 | **Attendee states:** enrolled → completed (with `completed_on`) \| failed (with `completed_on`) \| did not attend; an attendee can be removed with a reason. A completed attendee is frozen (correct it by voiding with a reason and re-adding). The session is open → closed (when nobody is still enrolled) \| cancelled (with a reason). |
| CP16 | **Who runs a session depends on its provider type.** A session has `provider_type` **internal** or **external**: internal names a trainer from the Employees register (`trainer_employee_id`, required); external names the outside provider or trainer as text (`provider_name`, required, optional contact). Exactly one of the two is filled. |
| CP17 | **No new roles for now.** No built-in "Department manager" role is added; people who should see everyone's competence are given a custom role carrying `competence.read` (CP11). Roles and department-scoped reading are revisited later. |
| CP15 | **Seeding: none.** A new organisation starts with empty skills, positions and training; categories are seeded (they are lists, not content). Example content can be added later. |

## 3. Data model (all tenant tables: `organisation_id`, RLS, audit trigger, no table writes except where stated)

| Table | Purpose |
|---|---|
| `competence_categories` | Per organisation, seeded (Inspection, Measurement, Machine operation, Quality system, Health and safety, Other); `competence.manage` adds, renames, switches off; key fixed, nothing deleted. |
| `competence_skills` | `code` (unique per organisation, any case), `name`, category, description, `refresh_months` (1–120, optional), active / retired with reason. |
| `competence_positions` | `code`, `name`, description, active / retired with reason. |
| `competence_position_skills` | Position ↔ skill with `required_level` 1–4; replaced as a whole by a function, history kept in the audit trail. |
| `competence_employee_positions` | Employee ↔ position with `started_on`, `ended_on`; ended, never deleted. |
| `competence_assessments` | **Append-only.** Employee, skill, `level` 0–4, `assessed_on` (not in the future, in the person's time zone), assessor, optional `expires_on`, note, `status` current / superseded, link to what it supersedes. Written only by `app.record_competence_assessment`. |
| `competence_training_sessions` | `TS-YY-NNNN` per organisation; title, kind (course / on the job / external / induction / other), **`provider_type` internal / external with `trainer_employee_id` or `provider_name`** (CP16), `starts_on`, optional `ends_on`, hours, location, notes; skills it supports (`competence_session_skills`); status open / closed / cancelled (reason). Written only by functions. |
| `competence_session_attendees` | One row per employee per session: status enrolled / completed / failed / did not attend / removed (reason), **`completed_on`** (own date, not in the future, not before the session started), outcome note, who recorded it. Unique per session and employee while not removed. Written only by functions. |
| `competence_attachments` | Evidence files on an assessment, a training session (shared) or an attendee (their certificate); functions only, removed with a reason, never deleted; private `competence-files` bucket at `<org>/competence/<employee id>/<uuid>-<name>`, uploads via `app.competence_file_allowed`. |

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
- `app.create_training_session(…, employees[])`, `app.update_training_session` (until closed), `app.add_session_attendee`, `app.remove_session_attendee(id, reason)`,
  `app.complete_session_attendees(session, attendees[], completed_on, outcome, note?)` (several people on one day, or call again on another day),
  `app.fail_session_attendee`, `app.mark_session_attendee_absent`, `app.void_session_attendee(id, reason)`, `app.close_training_session`,
  `app.cancel_training_session(id, reason)`; all need `competence.assess`; a completed attendee cannot be changed except by voiding; `completed_on`
  cannot be in the future (the caller's time zone) or before the session started; a session closes only when nobody is still enrolled.
  Completing an attendee **does not create an assessment**: the assessor decides the level separately.
- Inactive employees are left out of the matrix and dashboard by default; their history stays readable.
- Positions held keep their dates: assigning the same position again after it ended starts a new row; an overlapping duplicate is refused.

## 5. Permissions

`competence.read`, `competence.manage`, `competence.assess` (new, role defaults in the migration).

| Role | read | manage | assess |
|---|---|---|---|
| Owner, admin, quality manager | yes | yes | yes |
| Quality engineer | yes | no | yes |
| Inspector, viewer | no (own record only) | no | no |

- **Controller-seat holders see everything** in the module whatever their role (`app.competence_can_read(org)` = `competence.read` **or**
  `app.holds_controller_seat(org)`; RLS, API guard and menu all use it). Reading only: managing and assessing still need their permissions.
- **"Department management":** there is no such role today. Until department-scoped reading is designed, give the people you mean a custom
  role carrying `competence.read`; they then see everyone's.
- **Every active member with a linked employee record can always see their own competence**, whatever their role. Site scoping is not applied
  in this slice (organisation-wide, like supplier quality).

## 6. API (`api/src/competence/`, everything through `DatabaseService.asUser`)

`GET|POST /competence/skills`, `PATCH /competence/skills/{id}`, `POST …/retire|reactivate`; same for `/competence/positions` plus
`PUT /competence/positions/{id}/skills`; `GET|POST /competence/categories`, `PATCH …/{id}`;
`GET /competence/matrix` (page-based: `positionId`, `departmentId`, `siteId`, `categoryId`, `skillId`, `status` gap|expiring|expired|all,
`q`, `page`, `pageSize`; cells carry level, required, gap, expiry, assessor, date), `GET /competence/people/{employeeId}` (profile: positions,
every skill with level, required, history, training records), `POST …/assessments`, `POST …/positions`, `POST /competence/positions-assignments/{id}/end`,
`GET|POST /competence/training-sessions` (list: `q`, `status`, `from|to`, `skillId`, `employeeId`; a session is created with its attendee list), `GET|PATCH /competence/training-sessions/{id}` (the session with its attendees),
`POST …/{id}/attendees` (add), `POST /competence/session-attendees/{id}/remove|void|fail|absent`, `POST …/{id}/complete-attendees {attendeeIds, completedOn, outcome, note}`, `POST …/{id}/close|cancel`,
`GET|POST …/{id}/attachments`, `POST /competence/attachments/{id}/delete|restore`, `GET /competence-dashboard?from&to`, `GET /competence/me`
(own record, any member with a linked employee), `GET /competence/people/{employeeId}` also lists the sessions the person attended. New routes are `@OrganisationScoped` and get sample bodies in the tenancy sweep.

## 7. UI (`src/components/competence/`, hooks `useCompetence.js`, helpers `lib/competence.js`)

Menu group **Competence** (`GraduationCapIcon`, `/Competence`): **Dashboard** (default), **Matrix**, **Training sessions**, **My competence**
(shown to anyone with a linked employee record). Skills, positions and categories are set-up lists and live in
**Settings → Data Management → Competence** (a new tab with the same icon), as for the other modules.

- **Matrix** (`/Competence/Matrix`): the shared table pattern with sticky person column and one column per skill (grouped by category),
  level shown as a 0–4 dot scale and colour-safe badges (gap / expiring / expired carried by words and icons too), filters in the URL,
  CSV export, click a cell or person to open the profile.
- **Person profile** (`/Competence/People/:employeeId`): positions held, each skill with level, required, expiry and history, **Assess**
  dialog (skill combo, level, date, expiry, note, evidence), training records with files, link back to the Employees record.
- **Training sessions** (`/Competence/Training`, register with server paging and URL filters; `/Competence/Training/:id`): the session page shows its
  facts, supported skills, files and the **attendee list** with a status pill each, a **completed on** date per person, and actions: **Mark
  completed** (tick several people, choose the date, outcome: they can be completed on different days by repeating it), Failed, Did not
  attend, Remove with a reason, Void with a reason, **Close** and **Cancel**. A completed attendee can be given an evidence file (certificate).
  The person profile lists the sessions they attended.
- **Dashboard** (`/Competence`, shared period picker): people with gaps, assessments expiring in 30/60/90 days, expired, nobody-assessed
  employees, training recorded in the period, lists of the worst gaps and next expiries.
- Optimistic saves for small edits, `CTAButton` / `RHFComboBox` / `RHFDatePickerPopout` / `Callout` / `DropdownMenu` as elsewhere, required
  fields marked, every mutation hook calls `refreshOrganisation`.

## 8. Slices

| Slice | Content |
|---|---|
| **CO1 (done 2026-11-11, migration `20260127100000_competence_core.sql`, applied live)** | Migration: categories, skills, positions, position skills, permissions and role defaults, menu and Settings tab shell. API + Settings UI for categories, skills, positions. |
| **CO2 (done 2026-11-11, migration `20260128100000_competence_assessments.sql`, applied live)** | Employee positions (with dates), assessments (append-only), current level, gap and expiry worked out on read, skills matrix, person profile, My competence. |
| **CO3** | Training sessions with attendee lists, per-attendee completion dates, evidence files and the bucket, Training sessions register and session page. |
| **CO4** | Dashboard, expiry lists, CSV export of the matrix, in-app notice to an employee when assessed (event `competence_assessments.created`, to the linked sign-in only). |
| **CO5** | Exit check: live guardrails, advisors, browser journey step, `docs/competence-exit-report.md`, `CLAUDE.md`. |

Each slice ships with SQL tests (rules above with deliberate mutants), API e2e (both sweeps), frontend tests and, as always, lint, build,
`npm run db:check` and the API suites before commit.

## 9. Out of scope (stated so it is not assumed)

Blocking or gating work on competence; a course catalogue, quizzes, calendar booking or e-learning; department-scoped and role-narrowed visibility (deferred, CP11); reminders by email or push (expiry is shown, not
pushed); scheduled worker; linking skills to machines or control-plan operations (the job hub warning is a later slice and would build on
CP5's positions); appraisals, pay or contracts; supplier or customer personnel; importing skills or assessments (a later integrations entity).

## 10. Questions answered, and what is left

Answered on 2026-11-11: department management see everyone's and Controllers see everything (CP11; narrowing deferred); one training session
with an attendee list completed on different days (CP12, CP14); dates kept for position history (CP13); start empty (CP15); the session's
trainer follows its internal / external provider type (CP16); roles are left for now (CP17).

Nothing is left open. Next step: agree the plan, then start CO1.
