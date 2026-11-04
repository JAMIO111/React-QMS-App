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
