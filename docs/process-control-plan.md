# Process Control, In-Process Inspection and SPC — plan

**Status:** agreed (decisions §8, 2026-11-04) · **Date:** 2026-11-04 · **Branch:** `Dev`
**Source brief:** *Fortress — Process Control & In-Process Inspection: Architecture Brief*
(4 Nov 2026, referred to below as **PCB**) · **Project brief:** `docs/design-brief.md`
**Replaces:** Phase 2 slices **2.2** (inspection plans) and **2.3** (inspection results) in
`docs/phase-2-plan.md` §2.2 / §6 — the PCB is a fuller design of the same thing.

Core principle (PCB p.1): *separate reusable process requirements (control plans) from individual
part specifications and from actual inspection events, and keep an immutable snapshot of the
requirements used for every inspection.* Control charts (SPC) are the last step, built only on
traceable, validated measurements (PCB §8, §15: "statistical sophistication built on incorrect
source data is worse than no SPC at all").

## 1. What exists and is reused (PCB §15)

| Need | Existing piece | Change |
|---|---|---|
| Part identity | `parts` (unique part number per org) | add `part_family_id` |
| Part specification revision | `part_revisions` (draft → released → superseded → obsolete, one released per part, `drawing_ref`) | reused as the PCB's *part_specifications*; gains per-revision characteristic values |
| Units | `units` (global catalogue, no conversions) | reused; **no unit conversion** — a measurement must be in the requirement's unit (PCB §12 "reject incompatible units") |
| Equipment / calibration state | `gauges` (status, `next_due`), `calibrations` | measurements reference a gauge; status and due date copied at time of use |
| Nonconformance | `nonconformances`, `POST /…/raise-ncr` pattern from calibration | new link table to inspections/measurements |
| Audit, outbox, tenancy | `audit.events` trigger, `app.emit_event`, RLS helpers, guardrails, sweeps | every new table follows the tenant-table checklist in `CLAUDE.md` |
| UI kit | `Table`/`TableWrapper`, `RHFComboBox`, `RHFDatePickerPopout`, `MenuCard`, `Dialog`, Recharts + `--chart-*` colours | reused |

## 2. Data model (Postgres, all tenant-owned, RLS, audited, no DELETE)

Names follow the PCB §7 logical schema, adapted to repo conventions (composite
`(id, organisation_id)` keys, `app.stamp_created()`, column-level UPDATE grants, `NUMERIC` for
every measured or limit value — never float).

**Families, part specifications and machines**
- `machines` (decision P4): code (unique per org), name, site_id, work_centre, active.
- `part_families`: code (unique per org, case-insensitive), name, description, active.
- `parts.part_family_id` (nullable; a part belongs to at most one family).
- `part_revision_characteristics`: part_revision_id, `characteristic_key` (e.g. `LENGTH`,
  `GROOVE_POS`; unique per revision), nominal, lower_limit, upper_limit, unit_id, notes.
  Editable only while the revision is a draft (existing revision lifecycle trigger extended).

**Control plans** (configuration area: *Process Control Plans*)
- `control_plans`: plan_code (e.g. `CP-HCR-001`, unique), title, owner, active. Identity only.
- `control_plan_applicability`: plan_id + part_family_id, optional part_id / site_id / operation
  code. Supports one-to-many plans per family (PCB §2).
- `control_plan_revisions`: plan_id, revision_code (organisation's own convention, free format),
  status `draft → pending_approval → approved → effective → superseded | obsolete`,
  change_reason (required), effective_from/until, supersedes_revision_id, submitted/approved
  by+at, approval comment. Only drafts are editable; **an approved revision is never edited**
  (DB trigger, `QM007` → `409 control_plan_rule`). Effective-date overlap for the same scope is
  refused.
- `control_plan_operations`: revision_id, operation_code (`OP-020`), sequence, name, optional
  machine_id (decision P4) or work centre text.
- `control_plan_characteristics`: revision_id, operation_id, stable `characteristic_key`, number,
  name, `mode` `fixed | variable | conditional`, `data_type` `variable | attribute`, unit_id,
  for fixed: nominal/LSL/USL; for variable/conditional: `spec_key` binding to
  `part_revision_characteristics.characteristic_key`; method, gauge_type_id (equipment
  requirement), criticality, `spc_eligible`, `chart_type` (`imr | xbar_r`), subgroup_size.
- `characteristic_applicability`: plan_characteristic_id + part_id (explicit list for conditional
  characteristics — no free-text rules).
- `sampling_rules`: plan_characteristic_id, `trigger_type`
  `first_off | last_off | every_n_minutes | every_n_parts | start_of_shift | after_tool_change | after_setup | manual`,
  interval_value, sample_size. Structured, not a text string (PCB §3).
- `reaction_plans`: plan_characteristic_id (or revision-wide), trigger
  `out_of_spec | spc_signal | gauge_invalid | missed_check`, instruction, `action`
  `warn | hold | notify | raise_ncr`.

Creating a new revision copies the latest approved/effective revision and all its children
(server-side function, one transaction).

**In-Process Inspection** (operator-facing)
- `inspection_records`: reference `IPI-YY-NNNN`, site, part_id, part_revision_id, control_plan_id,
  control_plan_revision_id, operation_id, machine_id, work_order, lot, serial (text until
  Phase 3), operator (from auth), status `in_progress → completed | abandoned`, trigger,
  started/completed at, `snapshot jsonb`.
- `resolved_inspection_requirements`: one row per applicable characteristic, frozen at creation:
  source plan characteristic + source spec value ids, resolved nominal/LSL/USL/unit/method/
  equipment/sampling, `applicable` + reason. Read-only after insert.
- `inspection_samples`: record_id, sample_number, subgroup_number, sampled_at, unit/serial
  reference, trigger.
- `inspection_measurements`: sample_id, requirement_id, value_numeric (`NUMERIC`, never rounded) /
  value_pass, unit_id (must equal the requirement's unit), `result` `pass | fail` worked out by
  the DB against the unrounded value (on-limit passes), gauge_id + gauge status and next-due copied
  at entry, `gauge_override_reason`/`by`, `supersedes_id` + `correction_reason` (corrections are
  new rows — the original is never overwritten), `retest_of_id` (retests never replace a failed
  reading).
- `inspection_ncr_links`: ncr_id + record_id / measurement_id (many measurements → one NC).

**Requirement resolver** (PCB §5, §13 phase 3): a SQL function
`app.resolve_inspection_requirements(part_revision_id, plan_revision_id, operation_id)` used inside
the inspection-create transaction and exposed read-only for a *preview*. It **refuses** (no
inspection created) when: the part is not in the plan's family/scope; the part revision is not
released; no effective plan revision, or more than one (ambiguity); a variable/conditional
characteristic has no spec value; units differ. Tested independently in SQL and through the API.

**SPC**
- No stored copies of measurements: charts read `inspection_measurements` live.
- `spc_baselines`: characteristic_key + part_id + operation scope + chart type, baseline window
  (from/to or first N subgroups), calculated CL/UCL/LCL (+ R-chart limits), rule set, calculated
  at/by, `superseded_by` and reason. Recalculation adds a new row; old limits remain visible.

## 3. Rules (enforced in the database, re-checked by the API)

1. Approved/effective/superseded revisions and their children are immutable.
2. At most one effective revision per plan scope at any instant.
3. Inspections are only created against an **effective** revision and a **released** part
   revision; the snapshot never changes after creation (new revision ⇒ new inspection).
4. Measurement unit must equal the requirement unit; result computed on the raw `NUMERIC` value.
5. Corrections and retests are new rows linked to the original; nothing is updated in place once
   recorded.
6. Gauge must be `active` and not overdue at time of use, otherwise an override reason is
   required (permission `inspection.override_gauge`); state is copied onto the measurement.
7. **SPC only charts compatible data**: one characteristic key, one part number (never mixed
   nominals), one unit, one operation; I-MR for subgroup size 1, X-bar/R for 2–10 with complete
   subgroups. Spec limits and control limits are shown separately. A rule violation is a *process
   signal*, never an automatic product NC (PCB §8).

## 4. Permissions (PCB §10)

| Code | Operator | Quality eng. | Quality mgr / approver | Supervisor | Auditor |
|---|---|---|---|---|---|
| `process_control.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `process_control.manage` (draft plans, families, spec values) | | ✓ | ✓ | | |
| `process_control.approve` (approve/release/obsolete; approver ≠ author) | | | ✓ | | |
| `inspection.read` / `inspection.record` | ✓ / ✓ | ✓ / ✓ | ✓ / | ✓ / ✓ | ✓ / |
| `inspection.correct`, `inspection.override_gauge` | | ✓ | ✓ | ✓ | |
| `spc.read` / `spc.manage` (baselines, rules) | ✓ / | ✓ / ✓ | ✓ / ✓ | ✓ / | ✓ / |

Mapped onto the existing system role templates (Owner/Admin/…) and copied to existing
organisations, as in previous slices. Site scoping follows the inspection's site.

## 5. Screens (PCB §11)

- **Process Control** menu: *Control Plans* (register → plan detail: revisions, applicability;
  revision editor: operations, characteristics, sampling, reactions; *Compare with previous*;
  submit / approve / make effective), *Part Families* (list, detail with parts and linked plans).
  Part detail (Master Data) gains a *Specification values* tab per revision.
- **In-Process Inspection**: Start (pick/scan part, operation, work order, lot → resolver preview
  → start), entry screen (due checks; nominal, LSL, USL, unit, method next to each input; tablet
  sized; keyboard and touch; pass/fail shown with icon + text, not colour alone), history register.
  *Raise NC* from a failed measurement, sample or record (draft NC pre-filled and linked).
- **SPC**: characteristic chart — filters part / operation / machine / date / lot; I-MR or
  X-bar/R with CL/UCL/LCL and LSL/USL drawn differently; signals marked with rule name; baseline
  panel (window, calculate, history of limits); data sufficiency warnings (< 20 subgroups / < 25
  individuals ⇒ "limits are provisional").

## 6. Delivery slices

Each is a complete vertical slice (migration + `db:check` + API + e2e + UI + docs), committed
separately and applied to the live project before the next starts.

| Slice | PCB phase | Content | Exit check |
|---|---|---|---|
| **PC1** | 1 | Machines, part families, `parts.part_family_id`, part revision characteristic values; control plan identity, applicability and revisions (lifecycle only) | part joins a family; plan revisions versioned and scoped |
| **PC2** | 2 | Operations, fixed/variable/conditional characteristics, sampling rules, reaction plans; new revision by copy; comparison; submit/approve/effective | a quality user drafts, compares, approves and releases a revision |
| **PC3** | 3 | Requirement resolver + preview | correct requirements for different family parts; missing/ambiguous data blocks |
| **PC4** | 4 | Inspection records, samples, measurements, gauge validation, corrections, retests | operator records traceable measurements against a frozen snapshot |
| **PC5** | 5 | Raise NC from measurement/sample/record, links, reaction-plan prompts | NC keeps source traceability, pre-filled |
| **PC6** | 6 | SPC MVP: I-MR and X-bar/R, baselines, Western Electric rules 1–4 (each switchable), signal display | only compatible data charted; spec and control limits distinct |
| later | 7–8 | P/NP/C/U charts, Cp/Cpk/Pp/Ppk with sufficiency checks, family/machine analysis, alerts, scheduled-check overdue notifications (needs a worker) | |

Demo data (`supabase/seed/process_control_demo.sql`): the PCB's hydraulic-rod example — family
HCR, parts HCR-100/200/350, plan CP-HCR-001 (OD 25.00 ± 0.05 fixed, Ra ≤ 1.6, LENGTH variable,
GROOVE_POS conditional), and enough inspections to draw meaningful charts.

## 7. Out of scope here

Production orders and lots/serials as master data (design brief Phase 3 — free text
until then); unit conversion; offline operator mode; barcode hardware integration beyond a text
field that accepts scanner input; automatic gauge impact assessment (a report listing measurements
by gauge and date range is included in PC4, no automatic rewriting — PCB §9).

## 8. Decisions needed

| # | Question | Decision (agreed 2026-11-04) |
|---|---|---|
| P1 | Does this replace Phase 2 slices 2.2/2.3? | Yes |
| P2 | Build order | PC1 → PC6 in order, one slice at a time; charts arrive in PC6 |
| P3 | Part specification revisions | Reuse `part_revisions` (add characteristic values) rather than a new `part_specifications` table |
| P4 | Machines / work orders / lots | **`machines` master table now** (code, name, site, work centre, active) used by plan operations, inspections and SPC filters; work orders and lots stay free text until Phase 3 |

## 9. Slice PC1 — foundations — done (2026-11-04)

**Database** (`20251108110000_process_control_foundations.sql`)
- Permissions `process_control.read` / `.manage` / `.approve` (Owner, Admin, Quality manager: all;
  Quality engineer: read + manage; Inspector, Viewer: read).
- `machines` (decision P4) and `part_families`: master data (members read, `master_data.manage`
  writes), codes unique per organisation regardless of case; `parts.part_family_id`. A part named in
  a plan's scope cannot change family.
- `part_revision_characteristics`: part-specific values keyed by `characteristic_key` (`LENGTH`,
  `GROOVE_POS`…), `NUMERIC` nominal/limits (either limit may be open), unit from the catalogue.
  Editable (and deletable) only while the part revision is a draft; a new draft copies the
  released revision's values.
- `control_plans`, `control_plan_applicability` (family + optional part of that family / site /
  operation code; rows may be deleted, audited) and `control_plan_revisions` with the lifecycle
  draft → pending_approval → approved → effective → superseded | obsolete, enforced by
  `app.control_plan_revision_rules()`: only drafts editable; submitting needs a change reason;
  approve/make effective/retire need `process_control.approve` (authors may discard their own
  drafts); a future-dated revision cannot be made effective early; making a revision effective
  supersedes the previous one (with `effective_until`); one working copy and one effective
  revision per plan; who/when of submission and approval set by the database. Errors `QM007` →
  `409 control_plan_rule`. Outbox event `control_plan.revision.status_changed`;
  `app.control_plan_history()` for the plan, scope and revisions.
- Approval independence (approver ≠ author) is recorded, not enforced, so single-person test
  organisations can work; an organisation setting can enforce it later.

**API:** `/machines`, `/part-families` (+ detail with parts and plans), `/parts` gains
`partFamily`/`partFamilyId` (and a `partFamilyId` filter), `/part-revisions/{id}/characteristics`,
`/part-revision-characteristics/{id}` (PATCH/DELETE), `/control-plans` (list with effective and
in-progress revision, create with first draft and optional family scope, detail, update,
`/history`, `/applicability`, `/revisions`), `/control-plan-applicability/{id}` (DELETE),
`/control-plan-revisions/{id}` (PATCH draft) and `/transitions` (`submit`, `withdraw`,
`send_back`, `approve` — effective straight away unless dated later, `make_effective`,
`obsolete`). A caller who can read but not change a revision gets 403.

**Frontend:** menu *Process Control → Control Plans* (register with family/status filters; plan page
with details, scope, revisions and their actions per permission, history); *Master Data* gains
*Part Families* (list, detail with parts and plans) and *Machines*; the part page gains a family
picker and *Specification values* per revision (locked unless draft; a new draft is selected
automatically).

**Tests:** SQL `process_control.test.sql` (+ guardrails audit list and the tenancy sweep seeded);
API e2e `process-control.e2e-spec.ts` and the sweep over every new route (132 e2e); frontend +10
(193). Browser check (UI → local API → throwaway Postgres, Supabase session stubbed): register,
approve with comment (A superseded), new draft and the "reason needed" refusal, history, family
page, part spec values (released locked, new draft edited), machines, dark mode — no console
errors, no failed API calls.

**Live (2026-11-04):** migration applied and recorded as `20251108110000`, in one transaction with a
smoke test as the real Owner (create family, plan, scope; A and B through approval to effective, A
superseded, 7 events, history) whose data was rolled back; 26 role grants (13 per role set: templates
and the one organisation); guardrails 0 violations.

**Next:** PC2 — operations, characteristics (fixed / variable / conditional), sampling rules,
reaction plans, copy-on-new-revision and revision comparison.

## 10. Slice PC2 — plan authoring — done (2026-11-04)

**Database** (`20251108120000_control_plan_authoring.sql`)
- `control_plan_operations` (code normalised, unique per revision; sequence; machine or work centre).
- `control_plan_characteristics`: stable `characteristic_key` (cannot be renamed; identifies the
  characteristic across revisions), number, name, operation (same revision, enforced by a composite
  key), `data_type` variable | attribute, `value_source` plan (fixed) | part_spec (bound by
  `spec_key`), `applies_to` all | selected (conditional), `NUMERIC` nominal/limits, unit, method,
  required gauge type, criticality, SPC (`imr` with subgroup 1 or `xbar_r` with 2–10), display
  decimals. One CHECK constraint holds the value rules per kind.
- `characteristic_applicability` (parts of a conditional characteristic; must be in the plan's scope),
  `sampling_rules` (first-off, last-off, every N minutes / parts, start of shift, after tool change,
  after set-up, on demand; one per trigger; interval required exactly for the "every N" kinds),
  `reaction_plans` (out of spec, SPC signal, gauge invalid, missed check → warn / hold / stop /
  notify / raise NC; per characteristic or revision-wide).
- Every child row carries `control_plan_revision_id`; add/change/remove only while the revision is a
  draft (`QM007`); audited; removing a characteristic removes its rules; an operation with
  characteristics cannot be removed; switching back to "all parts" clears the part list.
- A new revision copies the revision it supersedes (all children, part lists as they were).
- Submitting needs at least one characteristic and parts for every conditional one.
- `app.control_plan_history()` now covers the content (removed rows found through their delete events).

**API:** `GET /control-plan-revisions/{id}` (content, revision-wide reactions, parts in scope),
`GET …/comparison` (against the superseded revision or `?with=`), `POST …/operations`,
`PATCH|DELETE /control-plan-operations/{id}`, `POST …/characteristics`,
`PATCH|DELETE /control-plan-characteristics/{id}` (`partIds`, `sampling`, `reactions` replace their
sets), `PUT …/reactions`. Values are made consistent with the kind (pass/fail checks drop unit and
limits; part-specific checks drop limits) and problems are reported in words before the database
check. The comparison (`revision-compare.ts`, unit tested) lists added / removed / changed
characteristics with before → after fields, classifies limit changes as tightened / loosened /
shifted, and lists operation and general reaction changes.

**Frontend:** `/Process-Control/Plans/:planId/revisions/:revisionId`: operations with their
characteristics as operators read them (e.g. "25.00 (24.95 – 25.05) mm", "From part: LENGTH (mm)",
"Every 30 min × 5", "X-bar/R, n = 5"), add/edit dialogs (characteristic: kind, limits or spec key,
applies to all / selected parts, method, gauge type, criticality, sampling rules, reactions, SPC),
general reactions, and "Changes from revision X". Read-only unless a draft and `process_control.manage`.
The plan page links each revision and offers "Edit checks" on the draft.

**Tests:** SQL `control_plan_authoring.test.sql` (+ PC1 test, guardrails, tenancy sweep seeded);
API unit +4 (comparison), e2e `control-plan-content.e2e-spec.ts` + sweep over the new routes
(135 e2e); frontend +3 (196). Browser check extended: open the draft's checks, tighten OD,
add a conditional part-specific LENGTH check for HCR-200, comparison shows "Tolerance tightened" and
"1 added · 1 changed" — no console errors, no failed API calls.

**Next:** PC3 — the requirement resolver (effective plan revision + released part revision →
frozen requirements, blocking on ambiguity or missing values) with a preview on the plan page.

## 11. Slice PC3 — requirement resolver — done (2026-11-04)

**Database** (`20251108130000_requirement_resolver.sql`): `app.resolve_inspection_requirements(part,
operation?, site?, part revision?)` → jsonb. Runs with the caller's rights (RLS), read-only.
- Finds plans whose scope covers the part's family (and part / site / operation when given) and
  needs exactly one with an effective revision.
- Uses the part's released revision (or the one given, which must be released).
- Resolves each characteristic: fixed values from the plan; part-specific values from the part
  revision's value with the same `spec_key` (unit must equal the plan's); conditional ones are
  returned with `applicable: false` and the rule ("Only for HCR-200") rather than dropped. Each
  requirement keeps its sources (plan characteristic id, part value id), sampling rules and its own
  plus the revision's general reactions.
- `status: blocked` with every problem in words when: part inactive, no family, no released
  revision / revision not released, no plan or no effective revision, more than one plan
  (ambiguous — never picks one), operation not in the plan, missing part value, unit mismatch,
  no characteristics.
- PC4 will call it inside the transaction that creates an inspection and freeze the result.

**API:** `GET /control-plan-resolution?partId&operationCode&siteId&partRevisionId`
(`process_control.read`); the plan detail gains `scopeParts`.

**Frontend:** `ResolutionView` ("Ready for inspection" / "An inspection could not start" with the
reasons; requirements with values as the operator reads them, part-specific ones marked "from part
value …", excluded ones greyed with the rule). Shown as *Preview requirements* on the plan page
(choose a part in scope, optional operation) and *Inspection requirements* on the part page.

**Tests:** SQL `requirement_resolver.test.sql` on the brief's rod example (every blocking case,
ambiguity resolved by narrowing scopes to operations, other organisation refused) + the tenancy
sweep; API e2e +2 (137); frontend +2 (198). Browser check: preview for HCR-100 ready, an operation
outside the scope blocked with the reason, part page shows the requirements — no console errors,
no failed API calls.

**Next:** PC4 — In-Process Inspection: start an inspection (resolver + frozen snapshot), samples
and measurements (unrounded values, unit equal to the requirement's, pass/fail by the database),
gauge validation from Calibration, corrections and retests as new rows.

## 12. Slice PC3b — scope and master-data refinements — done (2026-11-04)

**Decisions (agreed 2026-11-04):** a plan for a single part **overrides** family plans for that part
(two plans at the same level still block); parts can have **several customers**.

**Database** (`20251108140000_scope_and_part_customers.sql`)
- `part_customers` (part, customer, the customer's own part number, one primary — the first added
  becomes primary, making another primary moves the flag, removing the primary promotes another).
  Existing `parts.customer_id` links copied in as primary, then the column is dropped. The NC form
  keeps its own customer (unchanged).
- `control_plan_applicability.part_family_id` is optional when a part is named (check: family or
  part). Only scope entries naming a part *with* its family stop the part changing family. Parts of
  conditional characteristics may be in the family scope or named directly.
- Resolver: candidates are plans naming the part or covering its family; if any plan in force names
  the part, only those count (`scopeLevel: part`, `overriddenPlans` lists the family plans it
  replaces); otherwise family plans; more than one at the chosen level → `ambiguous_plan`. A part
  with no family resolves when a plan names it (standalone plans).

**API:** parts gain `customers` (detail) and keep `customer` as the primary; `POST /parts/{id}/customers`,
`PATCH|DELETE /part-customers/{id}`; part search also matches customer part numbers and the
`customerId` filter covers every customer of a part. `POST /part-families/{id}/parts {add, remove}`
(bulk; moving from another family allowed). Scope entries accept `partId` without `partFamilyId`;
plan summaries list `parts` named on their own.

**Frontend:** part page *Customers* card (add with their part number, make primary, remove); family
page *Add parts* (search, multi-select, warns which parts move from another family) and remove per
row; plan scope dialog chooses *A part family* or *A single part*; scope table and register show
single-part entries ("overrides family plans"); the requirement view says when the part's own plan
overrides a family plan.

**Tests:** SQL `scope_and_part_customers.test.sql` (+ master data, resolver, sweep, guardrails);
API e2e `scope-and-customers.e2e-spec.ts` + sweep over the new routes (140 e2e); frontend +3 (201).
Browser check: add a part to a family in bulk, add two customers with part numbers, change the
primary, find the part by the customer's part number — no console errors, no failed API calls.

## 13. Slice PC4 — In-Process Inspection — done (2026-11-05)

**Database** (`20251108150000_in_process_inspection.sql`)
- Permissions `inspection.read` / `.record` / `.correct` / `.override_gauge` (Owner, Admin, Quality
  manager, Quality engineer: all; Inspector: read + record; Viewer: read), site-scoped through the
  inspection's site.
- `inspection_records` (`IPI-YY-NNNN`, site, part + released revision, plan + effective revision,
  operation, machine, work order, lot, serial, trigger, operator, status `in_progress → completed |
  abandoned`, result, resolver snapshot) and `resolved_inspection_requirements` (frozen, one per
  characteristic, applicable or not with the rule). **Only** `app.start_inspection()` creates them: it
  checks `inspection.record` at the site, runs the resolver in the same transaction and refuses
  (`QM008`, the resolver's reasons) when it is blocked. Users have no INSERT on either table; the
  context and requirements never change.
- `inspection_samples` (numbered, time, unit/serial, trigger, retest flag; only while in progress).
- `inspection_measurements`, insert-only: `NUMERIC` value exactly as entered or pass/fail; unit equal
  to the requirement's; result by the database (limits inclusive, unrounded); the gauge's asset
  number, status and due date copied at the time of use; a gauge that is not active, overdue, deleted
  or not the required type (a gauge without a type is not the required type) needs a reason and
  `inspection.override_gauge`; a required gauge type needs a gauge; one first reading per check per
  sample; corrections are new rows (`supersedes_id`, reason, `inspection.correct`, each reading
  corrected once, also after completion); retests point at a failed reading and never replace it.
- Completion needs every applicable check measured; result `fail` when any current (uncorrected)
  reading failed. Abandon needs a reason. Events `inspection.started`, `inspection.completed` /
  `abandoned`, `inspection.measurement.failed`. All tables audited.

**API** (`api/src/inspection/`): `GET/POST /inspections` (list with search/status/result/part;
start), `GET /inspections/{id}` (context, requirements, samples, every reading with its correction
chain), `POST /inspections/{id}/samples` (sample + readings, all or nothing), `POST
/inspection-measurements/{id}/correction`, `POST /inspections/{id}/complete|abandon`. Values travel
as decimal strings so nothing is rounded between the screen and the database. `QM008` → `409
inspection_rule`.

**Frontend:** menu *In-Process Inspection*: register (`/Inspections`), start (`/Inspections/new`:
site, part, operation, machine, work order, lot, serial, trigger, live requirement preview; Start only
when ready) and the inspection page (`/Inspections/:id`): context, checks due from the sampling rules
(first-off, every N minutes; part-count and event triggers left to the operator), sample entry
(limits and method beside each input, large touch targets, gauge picker filtered by the required
type with its calibration state, override reason only for users who may override, live pass/fail with
icon and word using the database's rule), readings grid by check and sample (latest value of a
corrected reading, history dialog with corrections, gauge and retests; correct and retest actions),
not-applicable checks with their rule, Complete / Abandon.

**Tests:** SQL `in_process_inspection.test.sql` (+ sweep with a real inspection, guardrails); API e2e
`inspection.e2e-spec.ts` + sweep over the new routes (147 e2e); frontend +8 (209). The SQL test
found a real bug before release: a gauge without a type passed the "required type" check (NULL
comparison) — fixed with `coalesce(…, false)`. Browser check: start for HCR-100 at OP-020 with a work
order, a failing OD reading, correction with a reason, completion with result pass, register entry;
tablet width (820 px) entry screenshot — no console errors, no failed API calls.

**Next (was):** PC5 — Raise NC from a failed reading / sample / inspection (pre-filled, linked), reaction
plan prompts on failure.

## 14. Slice PC5 — NC integration from inspections — plan (2026-11-06)

**Decisions (agreed 2026-11-06):** (1) an NC raised from an inspection is source **`internal`** with a
link (as calibration does; no NC screen changes — the `inspection` source is not handled by the NC
screens and cannot be changed after creation); (2) an inspection **cannot be completed** while a
current failed reading is neither acknowledged nor linked to an NC; (3) a reaction with action "raise
NC" **prompts** (dialog opens pre-filled), it never creates silently; (4) **one NC per event**: tick
the failed readings that belong together (default all current failures); several NCs per inspection
are possible; with no readings ticked it is a manual NC for a defect no measurement caught.

**Database** (`20251108160000_inspection_ncr_integration.sql`)
- `inspection_ncr_links` (NC ↔ inspection ↔ reading; a null reading = manual NC): insert only through
  `app.raise_ncr_from_inspection()`, no UPDATE/DELETE, so a reading stays linked whatever happens to
  the NC; readable with `inspection.read` at the inspection's site.
- `inspection_failure_acknowledgements` (one per failed reading, note required, who/when set by the
  database): only for a *current* (uncorrected) failed reading of an open or completed inspection.
- `app.raise_ncr_from_inspection(inspection, readings[], title, description, severity, quantity,
  requirement, actual, open)`: needs `ncr.create` and `inspection.read` at the site; creates the NC
  (internal, draft or open) with part, part revision, site, work order, lot, serial, detection date
  and detector taken from the inspection (not overridable — traceability), the text fields from the
  caller; links every reading; emits `inspection.ncr_raised`.
- Completion rule in `app.inspection_record_rules()`: every current failed reading needs an
  acknowledgement or an NC link (QM008 lists them).
- `app.gauge_usage(gauge, from, to)` (needs `calibration.read` at the gauge's site): inspections and
  reading counts that used the gauge in a period — the impact assessment (PCB §9); reads only.

**API:** `GET /inspections/{id}/ncr-draft` (pre-filled suggestion, built by `ncr-draft.ts`: requirement
and actual result text, severity = highest criticality, quantity = failed samples, description with
machine/operator/gauge/plan revision and the **containment window** — last good reading to first
failure), `POST /inspections/{id}/raise-ncr`, `POST /inspection-measurements/{id}/acknowledge`;
inspection detail gains per-reading `acknowledgement` and `ncrs`; `GET /ncrs/{id}/inspection-source`;
`GET /calibrations/{id}/gauge-usage`.

**Frontend:** inspection page *Failures* card (each current failure with its reaction instructions,
Acknowledge / Raise NC, tick several to raise one NC, manual NC); Raise NC dialog (pre-filled,
editable); NC page *Source inspection* card; calibration page *Measurements made with this gauge*.

**Out of scope here (named, not forgotten):** holding a lot and alerting quality (need lot master data
and a notification worker — the `inspection.measurement.failed` event is emitted for that);
SPC-signal reactions (PC6); overdue-check alerts (worker).

**PC5 status (2026-11-06): done.** Migration `20251108160000_inspection_ncr_integration.sql`, API, UI and tests as agreed above (decisions: NC source `internal` + permanent link; acknowledgement or NC required before completing; reaction "raise NC" only prompts; one NC per event). Next: PC6.

## 15. Slice PC6 — SPC control charts (I-MR, X-bar/R) — plan (2026-11-06)

**Decisions (agreed 2026-11-06):** (1) subgroups are **explicit**: `inspection_samples.subgroup_number`, assigned by
the database when a sample is added (same inspection, same trigger, not a retest, group not yet full → join; else
a new subgroup; the operator can tick "start a new subgroup"); only complete subgroups of exactly the plan's size
are charted, everything else is listed as excluded with the reason; (2) **saved baselines** set by quality
engineers (`spc.manage`): a chosen window of data, calculated once and stored with the measurement ids used; a
recalculation adds a row and supersedes the old one (old limits stay visible); a chart with no baseline shows
**trial limits** from the data on screen, labelled provisional; (3) a rule violation is **display and prompt only**
— marked with the rule name beside the plan's `spc_signal` reaction instruction; it never creates an NC.

**Charted data (rule 7, enforced by the API):** one part, one `characteristic_key`, one operation, one unit, the
plan's chart type and subgroup size; the current (uncorrected) reading of each sample; **excluded and counted by
reason:** retests, abandoned inspections, other unit / chart type / subgroup size, other specification (nominal,
LSL, USL differ from the latest — never mixed), no subgroup recorded (older samples), incomplete subgroup. Gauge
overrides stay in the chart but are flagged. Readings are never copied: the chart reads `inspection_measurements`.

**Statistics** (`api/src/spc/spc.ts`, pure and unit-tested against textbook values): I-MR limits
`x̄ ± 2.66·MR̄`, MR chart `UCL = 3.267·MR̄`; X-bar/R `x̿ ± A2·R̄`, `D3·R̄`/`D4·R̄` (n = 2–10); σ̂ = `MR̄/1.128` or
`R̄/d2` (σ of the plotted mean for zones: `A2·R̄/3`). Western Electric rules on the location chart, each switchable
per baseline/view: **1** a point beyond 3σ; **2** two of three beyond 2σ, same side; **3** four of five beyond 1σ,
same side; **4** eight in a row on one side of the centre. Range/MR chart: a point above its UCL. No variation
(σ = 0) ⇒ zone rules skipped with a warning. Sufficiency: fewer than 25 individuals / 20 subgroups ⇒ "limits are
provisional"; fewer than 5 ⇒ no baseline can be saved. Spec limits (solid, labelled) and control limits (dashed)
are drawn and named differently — control limits are never presented as tolerance.

**Database** (`20251108170000_spc.sql`): permissions `spc.read` (all roles with inspection.read) and `spc.manage`
(owner, admin, quality manager, quality engineer); `inspection_samples.subgroup_number` + BEFORE INSERT assignment;
`spc_baselines` (scope part + characteristic_key + operation + chart type, subgroup size, unit, window, `n_points`,
`provisional`, spec set used, centre/UCL/LCL, dispersion centre/UCL/LCL, σ, enabled `rules`, `measurement_ids`,
notes, `superseded_at/by`): insert needs `spc.manage`, no UPDATE/DELETE for users, a SECURITY DEFINER trigger
supersedes the previous active baseline of the same scope, audited, in both sweeps and the guardrails.
Reading charts needs `spc.read` **and** `inspection.read` at the inspection's site (RLS on the readings).

**API** (`api/src/spc/`): `GET /spc/characteristics?partId` (chartable characteristics with point counts),
`GET /spc/chart?partId&characteristicKey&operationCode&from&to&machineId&lot&rules` (points, limits, signals,
exclusions, warnings, active baseline, reaction instructions), `GET /spc/baselines?…` (history),
`POST /spc/baselines` (calculates server-side from the chosen window, stores).

**Frontend:** menu *Process Control → SPC charts* (`/Process-Control/SPC`): part and characteristic pickers, date /
machine / lot filters, rule switches, location chart + range chart (Recharts, `--chart-*` colours, signal markers
by shape and text, a signals list), exclusions and warnings, baseline panel (window, calculate, history).

**Out of scope here:** P/NP/C/U charts, Cp/Cpk/Pp/Ppk, family/machine comparison, alerts and notifications,
raising an NC from a signal (decided: not now).

**PC6 status (2026-11-06): done.** Migration `20251108170000_spc.sql`, `api/src/spc/`, `src/components/spc/`, tests (SQL, 24 statistics unit tests, API e2e, component tests) and a browser check of the charts in light, dark and tablet width. Out of scope as listed above.

**PC5 follow-up (2026-11-06):** a later failed reading of an inspection can be added to an NC already raised from it — never automatically. The Failures card hints at the NC for the same check and offers *Add to NC-…* (or add a ticked selection to any open NC of the inspection); the dialog proposes the quantity affected (current + new samples). Draft … awaiting-closure NCs accept readings; closed, cancelled or deleted ones are refused (raise a new NC). Migration `20251112100000_inspection_ncr_add_readings.sql`.

**One live NC per reading (2026-11-06):** a failed reading can be on only one live NC (not cancelled, not deleted). Raising an NC or adding readings refuses one that is already covered (naming the NC); cancelling or deleting an NC frees its readings, which count as unhandled again for completion, the Failures card and the dashboard. The NC history gains "raised this from inspection …" and "added readings from inspection …" entries with the readings (migration `20251113100000_one_live_ncr_per_reading.sql`).

## 16. Slice PC7 — P chart (proportion of failed checks) — plan (2026-11-06)

**Decisions (agreed 2026-11-06):** (1) the **subgroup is chosen on the chart** — one inspection, one calendar day (UTC)
or one lot; the choice is saved with a baseline; (2) only **pass/fail (attribute) characteristics** are P-charted: the
plan marks one for SPC with chart type "P chart"; measured characteristics keep I-MR / X-bar/R.

**Data and statistics.** Each subgroup has *n* (checked) and *d* (failed); p = d/n. Centre line p̄ = Σd/Σn; limits vary with
each subgroup size, `p̄ ± 3·√(p̄(1−p̄)/nᵢ)`, clipped to 0…1. Retests, abandoned inspections and corrected readings are left out
exactly as for the other charts (current reading of each sample only; excluded counts by reason; subgroups by day need no lot,
by lot skip inspections without one, counted as excluded). The four Western Electric rules apply in units of each point's own σ
(z = (pᵢ − p̄)/σᵢ). Sufficiency: fewer than 5 subgroups ⇒ no limits; fewer than 20 ⇒ provisional; expected failures
n̄·p̄ < 5 (or n̄·(1−p̄) < 5) ⇒ warning that the normal-approximation limits are unreliable; p̄ = 0 ⇒ "no failures yet, no variation".
No specification lines: the chart's job is the process rate, not tolerance.

**Database** (`20251114100000_p_charts.sql`): `control_plan_characteristics` may be `spc_eligible` for an attribute check with
`chart_type = 'p'` (subgroup size null, set by the data); `spc_baselines` accepts chart type `p`, nullable subgroup size and
dispersion limits, and records `subgroup_basis` and `mean_subgroup_size` (centre = p̄; UCL/LCL stored at n̄ for reference — the
chart recalculates each point's limits from p̄ and its n).

**API:** `GET /spc/chart?…&subgroup=inspection|day|lot` (P charts return per-point `n`, `failed`, `proportion`, `ucl`, `lcl`),
characteristics list and `POST /spc/baselines` (`subgroup`) handle P; plan characteristic schemas accept chart type `p` only for
attribute checks; the dashboard's SPC overview includes P charts.

**Frontend:** characteristic form offers "P chart" for pass/fail checks; SPC page shows a *Subgroup* selector for P charts, a
proportion chart with stepped control limits (no range chart), n and failures in the tooltip and data table; baseline panel in
proportions. Demo data: `supabase/seed/spc_demo_p_chart.sql`.

**Out of scope here:** NP, C and U charts (they differ only in what is counted), % out-of-spec P charts for measured checks.

**PC7 status (2026-11-06): done.** Migration `20251114100000_p_charts.sql`; statistics `pSeries`/`detectPSignals`/`zoneRules` and data `assembleP`/`evaluateP` (unit tested); API chart, characteristics, baselines and dashboard overview handle P; characteristic form offers the P chart for pass/fail checks; SPC page has the Subgroup choice, `ProportionChart`, P data table and baseline panel; demo data `supabase/seed/spc_demo_p_chart.sql`. NP, C and U charts remain out of scope.

## 17. Slice PC8 — NP, C and U charts (defect counts) — done (2026-11-06)

**Decisions (agreed 2026-11-06):** (1) defect counts come from a **new "defect count" check type** (a third kind of
characteristic beside measured and pass/fail: the inspector enters how many defects were found on the unit); (2) the **NP
chart is a view of the P chart's data** (number failed instead of proportion failed): its subgroup size is **either set on the
chart or calculated automatically** (the most common size, larger on a tie) and subgroups of any other size are left out and
counted; (3) one plan choice, **"defects per unit"** (chart type `defects`): the chart is a **C chart** when every subgroup
inspects the same number of units and a **U chart** when the number varies. Subgroups are one inspection, one day or one lot,
chosen on the chart, as for the P chart.

**Count check.** `data_type = 'count'`: value source plan, no unit, nominal or lower limit; `upper_limit` is optional and means
*most defects allowed on one unit* (empty: recorded for charting, never fails). A reading is an exact non-negative integer
(`inspection_measurements.value_count`); its result is pass when no limit is set or the count is within it, otherwise fail —
so failing counts go through the normal acknowledge / NC flow. Corrections and retests work as for other readings. Each
sample is one unit.

**Statistics.** Subgroup *i* has nᵢ units and dᵢ defects. U chart: centre ū = Σd/Σn, uᵢ = dᵢ/nᵢ, limits `ū ± 3√(ū/nᵢ)` (LCL ≥ 0);
C chart (all nᵢ equal to n): plotted dᵢ, centre c̄ = n·ū, limits `c̄ ± 3√c̄`. NP chart (equal subgroups of n): plotted dᵢ of
failed checks, centre n·p̄, limits `n·p̄ ± 3√(n·p̄(1−p̄))`. Rules 1–4 apply in each point's own σ. Warnings: fewer than 5 subgroups ⇒
no limits, fewer than 20 ⇒ provisional, expected defects per subgroup below 5 ⇒ the (normal / Poisson) approximation is
unreliable. NP and P share one saved baseline (p̄ and its subgroup basis).

**Database** (`20251115100000_count_checks.sql`): `data_type` `count` on control plan characteristics, templates and the frozen
requirements; chart type `defects` (subgroup size null) for count checks; `value_count` on measurements with the one-value
rule extended; `app.inspection_measurement_rules` works out the result of a count; `spc_baselines` accepts chart type `defects`.

**API:** reading inputs, corrections and plan schemas take counts; `GET /spc/chart` accepts `display=np` and `size=auto|N` for P
characteristics and charts count checks as C or U (`variant` in the response); baselines for `defects`.

**Frontend:** characteristic form offers "Defect count" (optional max per unit, "defects per unit" SPC); the entry screen takes
integer counts with the live result; SPC page: *Show as* (P / NP) with the NP subgroup size, C/U chart with per-subgroup
limits; demo data `supabase/seed/spc_demo_count_chart.sql`.

**Out of scope here:** Cp/Cpk/Pp/Ppk, family and machine analysis, alerts.

## 18. Slice PC9 — process capability (Cp, Cpk, Pp, Ppk) — done (2026-11-06)

Decisions taken without further questions (redirect if wrong): computed live on the chart from the readings shown (same filters), no new
table or migration; measured characteristics only (I-MR, X-bar/R); within σ is the control chart's σ (R̄/d2 or MR̄/1.128 from the saved baseline,
else trial limits), overall σ the sample standard deviation (n − 1) of every reading shown; needs at least one specification limit and 10
readings, warns under 30 and when the chart has signals; one-sided specifications give Cpu/Cpl/Ppu/Ppl and so Cpk/Ppk only; ppm expected assumes
normality. Out of scope: histogram, normality test, non-normal capability, Cpm, family/machine comparison.

## 19. Slice PC10 — family and machine analysis — done (2026-11-06)

Decisions taken without further questions (redirect if wrong): no migration; one new read endpoint `GET /spc/analysis` plus `partFamilyId`/`all` on
`GET /spc/characteristics`; "analysis" means comparing the *same characteristic* between groups, not a roll-up dashboard. Groups are machines (for one part or a
whole family) or the parts of a family. Retests and abandoned inspections are left out and counted; readings of another kind or unit than the most recent are
too. Measured values are rescaled to each reading's own tolerance so different parts can be pooled; only Pp/Ppk (overall σ) are reported because a within σ
belongs to one control chart. A group is called higher/lower only at |z| > 3 against all other groups together (a deliberately conservative bar). Out of scope:
ANOVA and other formal variance tests, machine trends over time, control-chart overlays per machine.

## 20. Slice PC11 — SPC alerts — done (2026-11-06)

Decisions taken without further questions (redirect if wrong): an alert is a stored record plus an in-app notification, raised when a sample is *saved*
(no background worker exists), from the chart the control plan already defines (saved baseline, else trial limits, the baseline's rules); only signals on points
recorded by that save alert. Two chart rules fire together for one spike (rule 1 and the moving range), and the next point back in control has a large
moving range too, so one outlier can raise up to three alerts; this is the chart's own behaviour, not filtered. Pass/fail and count charts alert by inspection
(one alert per inspection and rule). Acknowledging needs `spc.manage` and a note; alerts are immutable otherwise and never deleted. Out of scope: email/push,
per-characteristic alert settings or muting, escalation, a dashboard KPI, and re-evaluating when a baseline changes or a reading is corrected.
