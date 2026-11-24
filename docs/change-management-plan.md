# Change management (ECR / ECN) — plan

**Status:** planned 2026-11-24; decisions CH1–CH4 chosen by the user, the rest proposed (§2, "to confirm" marked) · **Nothing built yet** · **Branch:** `Dev`
**Menu name:** Change (`GitPullRequestArrow`) · **Slices:** CH1–CH6, CHX (exit check)

Per `docs/design-brief.md` §3.5 (preserve approval and revision history), §6.5 (a change creates a new revision) and Phase 4's "consistent
permissions, workflow, audit and record-linking patterns". The brief has no change-management domain of its own; this is the module that sits **above**
the revision lifecycles already built and ties them together. Like the other Phase 4 modules it is a complete, tested vertical slice per step and
**informs rather than blocks** by default, with one opt-in gate (CH1 below).

## 1. What it is for

Today a manufacturer who changes something in Fortress touches several unrelated records: a part revision (or a correction), a control plan
revision, one or more document revisions, a gauge type, a supplier approval, a training session, a risk assessment. Each has its own approval and
nothing says **they belong to one change**, why it was made, who agreed, from when it applies, or whether it worked.

A **change request** is the one record that says:

- **why** (the origin: an NC, an 8D action, an audit finding, a risk, a management review decision, a customer or supplier request, or "we want to improve");
- **what and where** (the scope: parts, families, machines, suppliers, customers, operations);
- **what else it touches** (an impact assessment by area, not a free-text guess);
- **who agreed** (a change board by function, each signing separately);
- **what has to be done** (tasks, each linked to the real record that does it, with that record's live status);
- **from when** (the cut-in point: a date, a production order, a lot or a serial number);
- **whether it worked** (a closing check, with an effectiveness result).

One record serves as both the request and the notice: **ECR** while it is being assessed and agreed, **ECN** (engineering change notice, a printable page)
once approved. The reference stays `ECR-YY-NNNN`.

**Not:** a PLM or bill-of-materials system (no part structure, no drawing vault), PPAP / APQP packages (a customer approval can be recorded, §9), FMEA,
project management or Gantt, an ERP change sync, automatic re-inspection or re-training when a change lands.

## 2. Decisions

| # | Decision |
|---|---|
| CH1 | **Opt-in gate** (chosen). By default a change informs and never stops a release. An organisation can switch on **"a revision named by a change cannot be released until that change is approved"** (`organisation_settings.change_gate_enabled`, default off, `organisation.manage`). Releases not named by any change are never touched. Built last (CH5) because it patches shared lifecycle functions. |
| CH2 | **Who can start one** (chosen): staff, **plus customers and suppliers through the portal**. A customer's change request on a part and a supplier's process-change notice (PCN) arrive as a **draft** change with the origin recorded, for staff to review, exactly as portal complaints arrive as draft NCs. Portal parts are CH6. |
| CH3 | **Approval by a change board of functions** (chosen). The change names which **functions** must sign (Quality, Engineering, Production, Purchasing, Sales / customer, plus the organisation's own), each signs separately with a comment, and **the person who raised the change cannot sign it** (as document approvals). A rejection returns the change to assessment with the reason; a new round asks everyone again (as `document_revisions.review_round`). |
| CH4 | **Effectivity is a cut-in point** (chosen): none, a date, a production order, a lot or a serial number, plus a note on existing stock (use up / rework / scrap / return). Recorded and shown, including on the trace page; **nothing is enforced on the shop floor**. |
| CH5 | **One record, ECR then ECN**: `change_requests` with a stage, no separate notice table. Stages: `draft → assessment → approval → approved → implementing → verifying → closed`, or `rejected` (decided, final) / `cancelled` (reason). After approval the stage is **worked out** (implementing while a task is open, verifying when none is), never set by hand, as the 8D stage. *Proposed.* |
| CH6 | **Tasks link to the real record that does the work** (kinds in §3) and **show its live status**; a task is closed by a person, and the change cannot close while a task is open. The database checks that a closed task's linked revision is in force. Tasks may also be plain (no record) for things the system does not hold (tell the customer, buy a new fixture). *Proposed.* |
| CH7 | **Start the work from the task**: "Start a part revision / control plan revision / document revision from this task" calls the existing function and links the new draft (the existing lifecycles, approvals and rules are unchanged). *Proposed.* |
| CH8 | **Impact assessment is a fixed list of areas** (Design / drawing, Process and control plan, Inspection requirements, Tooling and equipment, Gauges and measurement, Documents, Training, Supplier and purchasing, Customer, Risk assessment, Packaging and labelling, Stock and cost), each marked **affected / not affected / not yet assessed**, answered by someone with `change.manage`. A change cannot go to the board with any area not yet assessed. The organisation can switch areas off, not add to them in v1. *Proposed.* |
| CH9 | **Change types** (seeded per organisation, on / off, key fixed): Product design, Process, Tooling or equipment, Material or supplier, Measurement or inspection, Documentation or QMS, Software or other. A type may carry **"needs customer approval"** by default; the change can override it. *Proposed.* |
| CH10 | **Customer approval is recorded, not run here**: `customer_approval` none / required / requested / approved / rejected, with their reference, date and a file. A change that needs it cannot be marked implemented until it is approved or the person records why it is waived (reason). Asking the customer in the portal is CH6. *Proposed.* |
| CH11 | **Expedited changes are not special in v1.** There is no "implement first, approve later" path; a change can be marked `expedited` only to show it first and word the notices. The risk of retrospective approval is worth a decision before it is built (§10 Q2). *Proposed.* |
| CH12 | Permissions `change.read`, `change.raise`, `change.manage`, `change.approve` (§4). Tied to a package like every other permission (`features` rows for the Change module; `every_feature_priced.test.sql` fails otherwise). |
| CH13 | The existing **document change requests** stay where they are (a reader asking a document manager for a revision). An accepted one can be **attached to a change as its origin**; nothing is merged. *Proposed.* |

## 3. Data model (tenant tables: `organisation_id`, composite FKs, RLS, audit trigger, **no table writes: SECURITY DEFINER functions only**)

- `change_types`, `change_functions` — seeded lists (§2 CH3, CH9). A function names its **default signers** (members, any number); on/off, key fixed, never deleted.
- `change_requests` — `ECR-YY-NNNN` (counter per organisation and year, **`app.pad_number`**), title, `description` (what), `reason` (why), `type_id`, `urgency`
  normal | expedited, owner = the person who raised it, stage, `review_round`, `customer_approval` (+ their reference, date, waiver reason),
  `cut_in_kind` none | date | order | lot | serial, `cut_in_date`, order / lot / serial ids (composite FKs), `stock_note`, effectiveness fields (due date, result, note), reject / cancel reasons,
  approved / closed by + at, `origin_kind` + `origin_id` (set at creation, **never changed**).
- `change_links` — the **scope**, replaced as a whole: part, part family, machine, supplier, customer, production order, operation code (the risk-links shape).
- `change_impacts` — one row per change and area: affected | not_affected | not_assessed, a note, assessed by / at.
- `change_signoffs` — one per required function per round: function, signer (member), pending | approved | rejected, comment, decided by / at; **frozen once decided**.
- `change_tasks` — description, area, owner (member), due, status open | done (note, stamped by the database) | cancelled (reason); optional **linked record**: `part_revision`,
  `control_plan_revision`, `document_revision`, `gauge_type`, `training_session`, `supplier` (an approval or SCAR), `inspection_requirement`, `quality_alert`, `risk`; one
  record may sit on several changes but on **one open task per change**.
- `change_reviews` — append-only: the closing effectiveness check (effective | not_effective, note); a not-effective result reopens the change to `implementing` with a reason.
- `change_attachments` — files (drawings, customer letters, evidence), written by functions only, removed with a reason, never deleted; private `change-files` bucket at `<org>/change/<id>/<uuid>-<name>` (`app.change_file_allowed`; `change-files` joins `ORGANISATION_BUCKETS`).

Errors `QM035` → `409 change_rule`; another organisation's id `P0002` → 404.

## 4. Permissions

| Permission | Holds |
|---|---|
| `change.read` | everyone who can see the Change module (viewers included) |
| `change.raise` | raise a change, comment, attach files (operational: inspectors, quality engineers and up) |
| `change.manage` | assess impacts, set scope, edit while a draft, create and close tasks, cancel, record customer approval, close (owner, admin, quality manager, quality engineer) |
| `change.approve` | sign for a function, set the cut-in point, issue the ECN, configure types, functions and areas (owner, admin, quality manager) |

A signer must hold `change.approve` **and** be a named signer of that function on this change.

## 5. Rules held by the database

- **Raiser cannot sign** their own change; a signer signs once per round; a rejection needs a comment and sends the change back to `assessment` (new round, fresh signoffs).
- **Cannot go to the board** until every area is assessed, at least one function is required, every required function has a signer who holds `change.approve`, the scope has at least one link, and, if the type or the change needs customer approval, that is marked as needed.
- **Cannot be approved** until every required function's latest signoff is approved. The last signoff approves the change in the same transaction; the cut-in point is set by `change.approve` at approval (or before).
- **Origin, type, reference and raiser never change**; description and scope are editable only while `draft` or `assessment`; after approval only tasks, attachments, customer approval and the effectiveness result move.
- **Cannot close** while a task is open, while customer approval is required and neither approved nor waived, or without an effectiveness note. A done task with a linked revision needs that revision **in force** (`released` / `effective`); a plain task needs only the note.
- **Completed signoffs, reviews and a closed change are frozen** (trigger, even for SQL). Nothing is deleted.
- **Stage after approval is worked out** (`app.change_recompute_stage`, a trigger on tasks): open task → `implementing`, none → `verifying`, as the 8D stage.
- **The gate (CH5, opt-in):** a checked text patch to the lifecycle functions of `part_revisions`, `control_plan_revisions` and `document_revisions`: when the setting is on, releasing or making a revision effective refuses a revision that is linked by an open task of a change not yet `approved` or later (`QM035`, message names the change). A correction release is included.

## 6. API (`api/src/change/`, all through `DatabaseService.asUser`; `@Versioned('change_requests')` on the record's GET and PATCH)

`GET|POST /changes` (page-based: `q` over reference, title, description, linked part numbers; `stage` default **open** | all | stages, `type`, `owner=me`, `signer=me` (waiting on me),
`partId|supplierId|machineId`, `overdue`, `from|to`, `sort`, `order`, `page`, `pageSize`), `GET|PATCH /changes/{id}`, `PUT …/links`, `PUT …/impacts`, `PUT …/signers` (functions required and who),
`POST …/submit|send-to-board|cancel|reopen|close`, `POST /change-signoffs/{id}/decide`, `PUT …/effectivity`, `PUT …/customer-approval`, `POST …/tasks`, `PATCH /change-tasks/{id}`,
`POST /change-tasks/{id}/complete|cancel|reopen|start-revision`, `POST …/reviews`, `GET|POST …/attachments`, `POST /change-attachments/{id}/delete|restore`,
`GET /changes/mine` and `/changes/mine/count` (declared before `:id`), `GET /changes/linked?kind&id` (changes on any record, for the cards in §7), `GET /change-draft?kind&id`
(prefill for "raise a change from"), `GET /changes-dashboard?from&to`, `GET /changes/{id}/notice` (the ECN as data for the print page), settings routes for types, functions and areas.
Every command answers with the whole change.

## 7. UI (`src/components/change/`, hooks `useChange.js`, helpers `lib/change.js`)

- **Register** `/Change` (the usual pattern: `TableWrapper`, header search, filter drawer, chips, CSV, saved filters), **change page** `/Change/:id` as a stepper of the five stages with a **Still needed** callout (from the database's problem list), cards for what / why / origin, scope, impact assessment, board (signoffs by function), tasks, effectivity, customer approval, files, history, effectiveness.
- **ECN** `/Change/:id/notice`: one printable page (what, why, impact, who agreed, cut-in point, tasks), print view like the 8D report.
- **My changes** `/Change/Mine`: signoffs waiting for me, tasks given to me, changes I raised; menu badge `my-changes`.
- **Everywhere else:** a **Changes** card (`LinkedChanges.jsx`, as `LinkedRisks`) on the NC, 8D, audit finding, risk, part, part family, machine, supplier, control plan revision, document and gauge type pages, showing changes that name the record and **Raise a change** prefilled from it. **Trace page:** a change with a lot / order / serial cut-in point says which lots were built before and after.
- Settings → Data Management → **Change** (`SettingsChange.jsx`): types (with "needs customer approval"), functions with their default signers, impact areas, the gate switch.

## 8. Slices

| Slice | Content |
|---|---|
| CH1 | Permissions and package features; types, functions, areas seeded; `change_requests`, origin, scope links, attachments; draft → cancelled; register, page, Settings tab. |
| CH2 | Impact assessment, required functions, signoffs and rounds, approval, cut-in point, customer approval record, ECN print page, notices to signers and the raiser. |
| CH3 | Tasks with linked records and their live status, start-a-revision-from-a-task (part, control plan, document), the worked-out stage, closing with the effectiveness check, My changes and the badge. |
| CH4 | Raise a change from an NC, 8D (a corrective or preventive action), audit finding, risk, accepted document change request, management review decision; the Changes card on every linked record; trace page cut-in. |
| CH5 | The opt-in gate, dashboard, home page area, workflow triggers (`change.submitted`, `change.approved`, `change.closed`), reminders area (signoffs waiting, tasks overdue), management review input. |
| CH6 | Portal: a customer sends a change request on one of their parts, a supplier notifies a process change; both land as draft changes. Asking a customer to approve, as closure confirmation. |
| CHX | Exit check: live guardrails, advisors, browser journey step (NC → raise change → assess → board → approve → part revision and control plan revision started from tasks → released → closed with an effectiveness check), exit report. |

## 9. Reuse, not rebuild

Tasks reuse the action pattern (`risk_actions`, `capa_actions`); signoffs reuse the document review round; links reuse `risk_links`; the origin prefill reuses
`raise_risk_from`; notices, email, reminders and workflow triggers use their existing engines (a new reminder area and trigger follow the documented
steps in `CLAUDE.md`); the register, filters, saved filters, optimistic mutations, edit conflicts, import-free CSV export and the print view are existing components.
Customer approval is a record plus a file here; a PPAP submission package is a later use of the same field.

## 10. Questions to confirm before CH1

| # | Question | Proposed |
|---|---|---|
| Q1 | May the same person raise and sign a change in a one-person organisation? Document approvals refuse it; the part revision correction allows it. | Refuse (CH3), because a change board is the point of the module; revisit if small teams object. |
| Q2 | Is an **emergency change** (implement now, approve afterwards) needed in v1? | Not in v1 (CH11); it is a deliberate bypass and deserves its own rules. |
| Q3 | Should a change be **subscription-gated** to a package (Controller only, or every package)? | Observer view, Contributor raise, Controller manage and approve, as the other modules (`every_feature_priced`). |
| Q4 | Should closing a change **create a management review input**? | A small section ("Changes in the period: raised, closed, not effective") in CH5. |

## 11. Out of scope (stated so it is not assumed)

BOM or part-structure changes and drawing storage; PPAP / APQP packages; FMEA; cost approval and budgets (a note field only); project scheduling; automatic
re-inspection, re-training or re-qualification when a change lands; ERP or PLM sync of changes (the `external_system` / `external_id` pair is **not** reserved here);
email on a schedule beyond the existing reminders; editing a change after approval other than tasks, files, customer approval and the effectiveness result.
