# FMEA (design and process failure mode and effects analysis) — plan

**Status:** planned 2026-11-24; decisions FM1–FM16 proposed, **FM17 and the answers in §10 agreed 2026-11-25** (the user asked for this module to be planned and built before PPAP) ·
**Menu name:** FMEA (`ListTreeIcon`, to be checked in `components/icons`) · **Slices:** FM1–FM6, FMX (exit check) · **Builds before:** `docs/ppap-plan.md`

Per `docs/design-brief.md` §3.5 (preserve approval and revision history) and §6.5 (a change creates a new revision) and the Phase 4 pattern of one complete, tested
vertical slice per step, informing rather than blocking. The risk plan (§9) and the change plan (§1) both left FMEA out on purpose as "a separate later module that
should **feed** the risk register, not replace it"; this is that module.

## 1. What it is for

A **DFMEA** (design) asks of a part or product: *what could fail, what would that do to the customer, and what stops or catches it?* A **PFMEA** (process) asks the
same of a manufacturing process, step by step. The control plan is then supposed to be built **from** the PFMEA (what is prevented, what is measured, how often), and
the FMEA is supposed to be **kept alive** by what really happens: non-conformances, 8Ds, audit findings, changes.

Today Fortress has the control plan, the inspections, the SPC, the NCs and the 8Ds, but **nothing that says why the control plan looks the way it does** or
whether the failures that really occur were ever foreseen. The FMEA module closes that loop:

- it holds the analysis as **structured, versioned data**, not a spreadsheet attached to a document;
- it **rates** each failure cause (severity, occurrence, detection) with a model the organisation owns, and the **database works the priority out** so screen and record cannot disagree;
- it tracks the **actions** that reduce the risk, who owns them and whether they worked (new ratings);
- it **links to the control plan** (which control covers which cause) and tells you what is not covered;
- it uses **what really happened** (NC counts against a failure mode, an 8D root cause) to say "this FMEA may be out of date";
- it is the **evidence** PPAP elements 4 and 6 point at.

**Basis:** the AIAG & VDA FMEA Handbook, 1st edition (2019): seven steps (planning and preparation, structure analysis, function analysis, failure analysis, risk analysis,
optimisation, results documentation), **Action Priority (AP)** High / Medium / Low instead of the older RPN as the way to decide what needs action, and the 4M
work-element headings for a process. IATF 16949 expects FMEA output to feed the control plan and expects problem solving to review the FMEA (as I understand it; the clause
wording is to be checked against the organisation's own copy). Classic **RPN** (S × O × D) is also available because many customers still ask for it (FM5).

**Not:** a FMEA catalogue or library of "typical" failure modes shipped with the product (publisher's content, §10 Q1), automatic rating from SPC data, a
reliability or fault-tree tool (FTA, Weibull), a Functional Safety / ISO 26262 tool, DRBFM, FMEA-MSR (monitoring and system response; the table can be added later),
PLM-style product structure, an ERP sync.

## 2. Decisions (proposed)

| # | Decision |
|---|---|
| FM1 | **Two kinds, one engine**: `design` and `process` FMEAs share the tables and screens; the kind decides the structure words (system / sub-system / component and **function** vs process item / **process step** / **work element** and **function**), the rating scales and the control wording. |
| FM2 | **An FMEA is a record with revisions** like a control plan: the identity (`FMEA-001`) is separate from its revisions (rev A, B …). Revision status `draft → pending_approval → approved → effective → superseded | obsolete`; one in progress per FMEA; **the content is frozen once it leaves draft** and a new revision copies it. **The preparer cannot approve** (a different person with `fmea.approve`). |
| FM3 | **The analysis is stored as the handbook's "nets"**, not as flat rows: structure items (a tree) → functions → failure modes → effects and causes → controls and ratings. The screen shows the familiar **table form** (merged cells), and the same data prints as the handbook's form sheet. Flat rows would repeat the same failure mode wording and could not be linked to one control. |
| FM4 | **The rating model is the organisation's, in versions** (like the risk matrix and the supplier scoring model): the 10-level scales for severity, occurrence and detection (separate for design and process), a method **`ap`** or **`rpn`**, the RPN thresholds, and the AP grid. A revision **freezes the model version it was rated with**. The database scores (`app.score_fmea(model, kind, s, o, d)`), the API only asks. |
| FM5 | **Method**: the AP grid is **data** (ranges of S, O and D to H / M / L), set by the organisation, **not shipped by us**: the handbook's grid and scale wording are the publisher's (§10 Q1), and I could not confirm the grid from a public source. Until an AP grid is entered the model uses **RPN with thresholds** so the module works on day one; the screen says which method rated the row. Importing the grid from CSV (ranges) is part of FM2. |
| FM6 | **Severity belongs to the effect, occurrence and detection to the cause.** A failure mode may have several effects (at your plant, at the next plant, at the end user); **the severity used for a cause is the highest of its mode's effects**, worked out by the database. S 9–10 always shows as needing attention whatever the method says (the handbook's rule). |
| FM7 | **Special characteristics** (critical / significant, or the organisation's own symbols) are flagged on the cause or failure mode and **offered** to the control plan characteristic as its criticality; nothing is copied silently (FM11). |
| FM8 | **Actions are line items** (prevention or detection), each with an owner (a team member), due date, status open → done | cancelled (cancel needs a reason, done needs evidence), and **revised ratings** once done. They reuse the CAPA / risk action pattern (owner may close their own with `fmea.read` only). |
| FM9 | **An effective FMEA stays alive without a new revision**: **actions** (status, evidence, revised ratings) and **review notes** can change on an effective revision; **structure, ratings and controls cannot**. Starting the next revision offers to **adopt completed actions** (their text joins the controls, their revised ratings become the ratings), so history stays frozen and the update is deliberate. |
| FM10 | **Team and scope are part of the record** (handbook step 1): the cross-functional team (people from the Employees register or members, with a role: lead, process, quality, design, purchasing …), the scope (parts, part family, control plan, machines, operations), the customer(s) it is for, the intended use, the start and review dates. **Links are replaced as a whole**, like risk and change links. |
| FM11 | **Control plan link = carried, never copied silently.** A prevention or detection control on a cause can be **carried to the control plan**: pick the operation and the characteristic (by its stable `characteristic_key`, so it survives plan revisions) and the link is recorded with who and when. The **coverage report** lists the causes whose action priority is High (or severity ≥ 9) that **no control plan characteristic covers**. Information only. |
| FM12 | **Living FMEA**: a failure mode can be **tied to an NC failure mode** (the organisation's `ncr_classifications` of kind `failure_mode`). The FMEA then shows **how many live NCs were raised against it** in the last 12 months beside the occurrence rating ("rated O 3, but 14 NCs"), and an NC with a failure mode **not in the FMEA** is listed as "not foreseen". Information only; nothing is re-rated automatically. |
| FM13 | **Raised from a record**: an FMEA (or a new revision) can be started from an NC, an 8D, an audit finding, a change or a SCAR (`app.fmea_draft_from`, the risk / change pattern), and **the reason is kept** (`origin_kind` / `origin_id` never change). A change task can name an FMEA revision like it names a control plan revision (`fmea_revision` link kind), and 8D step D7 asks "was the FMEA reviewed?" with a link. |
| FM14 | **Periodic review**: a review date per FMEA (default interval in the model, e.g. 12 months), `fmea_reviews` append-only (no change needed — with a note — or revision started). Overdue is worked out on read; reminders and a workflow trigger follow in FM6. |
| FM15 | **Permissions and packages**: `fmea.read`, `fmea.manage`, `fmea.approve`; owner, admin, quality manager all three; quality engineer read + manage; inspector, viewer read. **Observer = view, Contributor = view, Controller = full** (like control plans; `features` rows tie every one, `app.unpriced_permissions()` is untouched). Errors `QM036` → `409 fmea_rule`; another organisation's id `P0002` → 404. |
| FM16 | **Informs, never blocks**: a part or plan with no FMEA, or a stale one, shows a banner; nothing stops an inspection or a release. A gate like the change module's is not planned (the owner decided against the change gate for the same reason). |
| FM17 | **Inheritance (agreed 2026-11-25; built in FM3).** An FMEA may be a **base** (a family or foundation FMEA linked to a part family, a machine, an operation or a control plan) that a **part's FMEA starts from**; an FMEA can equally be written **standalone, per part**, with no base. Inheritance is **copy with provenance, never a live reference**: `fmeas.base_fmea_id` (same kind; fixed once set) names the base, starting a child revision copies the base revision in force into the child's draft, and every copied row keeps `source_row_id` and the base revision it came from. The child may add, change or remove rows (a changed or removed inherited row says why, in words). When the base later gets a new revision the child page says "the base moved on" and lists the differences (rows added, changed or removed in the base since); **bringing them in is the preparer's deliberate edit in the next child revision**, so a frozen revision never changes under anyone. Information only; nothing blocks. |

## 3. Data model (tenant tables: `organisation_id`, composite FKs, RLS, audit trigger, **no table writes: SECURITY DEFINER functions only**; numbers by `app.pad_number`)

- `fmea_models` — versions: `kind_scales` (design and process: ten levels each for S, O, D, with a short label and the organisation's own criteria text; seeded with **neutral generic labels** "1 — none … 10 — very high" only), `method` `rpn` | `ap`, `rpn_high_from`, `rpn_medium_from`, `ap_rules` (a list of `{sFrom, sTo, oFrom, oTo, dFrom, dTo, ap}`), `severity_floor` (9, always needs attention), `review_months`, `reason`; **frozen**; `app.fmea_model_problem(config)` is the one definition of valid (the AP rules must cover every S, O, D combination exactly once; ranges 1–10; scale texts ≤ 300). A default model is seeded per organisation by `app.seed_fmea_model`; a new version only by `app.save_fmea_model(org, config, reason)` (`fmea.approve`, unchanged refused).
- `fmeas` — `FMEA-NNN` (counter per organisation), `kind`, title, intended use / scope text, `customer_id` (optional), owner (active member), `status` active | withdrawn, `current_revision_id`, `next_review_on`, `review_months` (own interval, null = the model's), `origin_kind` + `origin_id` (never change).
- `fmea_revisions` — sequence, **letter null until submitted** and never reused (the document pattern), status as FM2, `model_id` (the version rated with), `change_summary`, approver, effective dates, `previous_revision_id`, `superseded_by_id`; content frozen by trigger (`app.fmea_revision_rules`, even for SQL).
- `fmea_team_members` — per revision: employee (Employees register) **or** member (a user), role, **one lead**; replaced as a whole with the revision's content.
- `fmea_links` — the scope per revision, replaced as a whole: part, part family, control plan, machine, operation code, supplier, customer.
- `fmea_items` — the structure tree per revision: `parent_id`, `kind` (design: system | subsystem | component; process: item | step | element), `element_type` for a process work element (man, machine, material, method, measurement, environment — the 4M + measurement + environment of the handbook), `name`, `position`, optional `operation_code` / `machine_id` / `part_id` link.
- `fmea_functions` — per item: the function and its requirement (text), optional `characteristic_key`.
- `fmea_failure_modes` — per function: the failure mode (text), optional `ncr_failure_mode_id` (FM12), optional special characteristic class.
- `fmea_effects` — per failure mode: `level` (your plant | next plant | end user), text, **severity 1–10**.
- `fmea_causes` — per failure mode, **owned by a work element for a process**: cause text, `prevention_controls`, `detection_controls`, **occurrence**, **detection**, and the worked-out `severity_used`, `ap` (H / M / L), `rpn`, `needs_attention`, `class` (special characteristic), `model_id` (so a row says which method rated it). **S, O, D are written by functions and the database fills the worked-out columns** (the supplier risk pattern); nothing a client sends for them is trusted.
- `fmea_actions` — per cause: kind prevention | detection, description, owner (member or employee), due date, status open | done | cancelled, evidence note, done by / at, cancel reason, **revised S, O, D and the worked-out revised AP / RPN**, `adopted_in_revision_id` once a later revision took it in. May change on an effective revision (FM9).
- `fmea_control_links` — a cause (or its control) ↔ a control plan characteristic: `operation_code`, `characteristic_key`, who and when, ended (never deleted).
- `fmea_reviews` — append-only (FM14).
- `fmea_signoffs`-style approval is **one approver per revision** (like a control plan revision), not a board: `approver_id` set by `app.set_fmea_approver`, `app.approve_fmea_revision` (the named approver, `fmea.approve`, never the preparer, an effective date today or later).

Functions (all `SET search_path = ''`; `fmea.manage` unless said): `create_fmea`, `update_fmea`, `set_fmea_team`, `set_fmea_links`, `add_ / update_ / remove_fmea_item`, `set_fmea_function`, `set_fmea_failure_mode`, `set_fmea_effect`, `set_fmea_cause`, `rate_fmea_cause` (S via effects, O, D, controls), `submit_fmea_revision` (the "still needed" list `app.fmea_revision_problems` must be empty; gives the letter), `approve_fmea_revision` (`fmea.approve`), `send_back_fmea_revision`, `start_fmea_revision(fmea, adopt boolean)` (copies the live revision; with `adopt` takes in completed actions), `discard_fmea_revision(reason)`, `withdraw_fmea(reason)`, `add_ / update_ / complete_ / cancel_ / reopen_fmea_action` (the owner with `fmea.read` may complete or reopen their own), `carry_to_control_plan(cause, operation, characteristic_key)` / `end_control_link(id, reason)`, `record_fmea_review`, `save_fmea_model`, `fmea_draft_from(kind, id)`. A revision settles to effective without a worker, as documents do (`app.settle_fmea`, run on read, plus the worker's housekeeping step).

**"Still needed" before a revision can be submitted** (`app.fmea_revision_problems`): a team with a lead; a scope link; every item has a function; every function has a failure mode; every failure mode has an effect with a severity; every failure mode has at least one cause; every cause has O and D rated, and a prevention or a detection control **or** an action; every cause that **needs attention** has an action or a written reason for taking none (no empty rows slip through, no invented numbers).

## 4. What it connects to (existing modules, nothing re-built)

| Existing | How |
|---|---|
| Parts, part families, machines, operation codes | the scope (`fmea_links`) and the structure's optional links; a part page gets an **FMEA** card and banner (FM16) |
| Control plans | carried controls and the **coverage report** (FM11); a control plan revision page shows which FMEA rows cover each characteristic ("covered by PFMEA row, AP H") |
| NC failure modes | occurrence evidence and "not foreseen" (FM12) |
| 8D (CAPA), audit findings, SCARs, changes | raise an FMEA or a revision from them (FM13); the 8D D7 step and a change task link to the revision |
| Risk register | **a cause can be raised as a risk** (`risk_links` gets the kind `fmea_cause`, `risk_draft_from` gains it): the FMEA is the analysis, the register is the owned risk (risk plan §9) |
| Documents | a revision's attachments (the printed form, supporting studies) are files on the revision, like document files |
| Competence, Employees | team members come from the Employees register; the FMEA team is evidence of who was involved |
| Notices, reminders, workflow, home, dashboard | action given to you, review due, `fmea.approved` trigger, home area, dashboard (FM6) |
| PPAP (next) | elements 4 (DFMEA) and 6 (PFMEA) link the **revision in force** and freeze it at submission |

## 5. API (`api/src/fmea/`, `@Versioned` on records people edit)

`GET|POST /fmeas` (page-based: `q`, `kind`, `status`, `partId`, `partFamilyId`, `owner=me`, `reviewOverdue`, sort), `GET|PATCH /fmeas/{id}`,
`POST /fmeas/{id}/revisions|withdraw|reviews`, `GET|PATCH /fmea-revisions/{id}` (the whole analysis as one document: tree, nets, causes with worked-out ratings, problems),
`PUT /fmea-revisions/{id}/team|links|signers`, `POST …/items|functions|failure-modes|effects|causes` and `PATCH|DELETE` of each (one route family, ids validated against the revision),
`POST /fmea-revisions/{id}/submit|approve|send-back|discard`, `GET /fmea-revisions/{id}/compare?with=`, `GET …/control-coverage`, `GET …/occurrence-evidence`,
`POST /fmea-causes/{id}/carry-to-plan`, `POST /fmea-control-links/{id}/end`, `POST /fmea-revisions/{id}/actions`, `PATCH /fmea-actions/{id}`, `POST …/complete|cancel|reopen`,
`GET /fmea-actions/mine`, `GET|PUT /fmea-model` (versions), `POST /fmea-model/preview {kind, s, o, d}` (nothing saved), `POST /fmea-model/ap-import` (CSV of ranges, checked), `GET /fmea-draft?kind&id`,
`GET /fmeas/linked?kind&id` (the FMEAs covering a part, plan, machine or NC failure mode, for banners and cards), `GET /fmea-dashboard`. The pure parts (the compare, the coverage, the evidence) are plain functions with unit tests.

## 6. UI (`src/components/fmea/`)

Menu **FMEA**: Dashboard (FM6), **FMEAs** (register in the usual pattern: `TableWrapper`, columns, header search, filter drawer, chips, saved filters, CSV), **My actions**.
Settings → Data Management → **FMEA** (the rating model: scales, method, thresholds, AP grid import, versions, "change the model" with a reason).

The FMEA page has the **stepper of the handbook** (Team and scope → Structure → Functions → Failures → Ratings → Actions → Results) and one **analysis table** (merged cells, one
cause per row, S / O / D as buttons showing the scale label, AP as a pill with the word, the control and the linked plan characteristic in the row, the NC count beside O),
a side panel for the item being edited, a **still needed** list, the revision lifecycle bar (submit, approve, send back, new revision, withdraw), compare with the
previous revision, **Print** (the handbook's form sheet; design and process variants) and CSV. Every answer saves as given (optimistic, rolled back on error), nothing needs a
"save all" button. Colour comes from the `--chart-*` status colours; every rating is also in words.

## 7. Slices

| Slice | Content |
|---|---|
| **FM1** (built 2026-11-25, migration `20260438100000_fmea_foundation.sql`; see CLAUDE.md) | Foundation: permissions, packages and module row, `fmeas`, `fmea_revisions` and their lifecycle (submit / approve / send back / new revision / withdraw / settle), team, links, register, FMEA page shell with team and scope, menu, tests. The submit check has only the rules of what exists so far. |
| **FM2** (built 2026-11-25, migration `20260439100000_fmea_rating_model.sql`; see CLAUDE.md) | Rating model: versions, scales, RPN and AP, AP import, `app.score_fmea`, preview, Settings tab; seeded neutral scales. |
| **FM3** *(built; migration `20260440100000_fmea_analysis.sql`, not yet applied live. Decided while building: only **leaf** items need a function; `special_class` sits on the failure mode, not the cause; the "base moved on" difference list moves to FM4 with compare)* | The analysis (with FM17 inheritance: `base_fmea_id`, copy with provenance, the "base moved on" differences): items, functions, failure modes, effects, causes, controls, ratings and the database's worked-out S / AP / RPN, special characteristics, the editor and the "still needed" list. |
| **FM4** *(built 2026-11-25; migration `20260441100000_fmea_actions.sql`, not yet applied live. Decided while building: an action answers a cause's "needs attention" and "no control" gaps on a draft; **a finished action revises only occurrence and detection, never severity** (severity belongs to the effect, so a lower severity is a design change made in a new revision, not something an action can claim); finished actions are taken into the next revision **only when the person starting it chooses to** (their words join the controls, their revised ratings become the causes' ratings, and discarding that draft gives them back); an open action is **carried on** to the revision that replaces the one it was on, as a new open action that says so, so none is stranded; the person an action is given to may finish or reopen it with only `fmea.read`, even on a draft they cannot otherwise open)* | Optimisation: actions, owners, My actions, revised ratings, adopting actions into a new revision, compare (by lineage, never by wording), the "base moved on" differences, periodic review, notices. |
| **FM5** *(in three parts)* | Links: carry to the control plan and the coverage report, occurrence evidence and "not foreseen", raise-from, risk link kind, change task kind, 8D D7 prompt, banners on part / plan pages. |
| **FM5a** *(built 2026-11-25; migration `20260442100000_fmea_control_links.sql`, not yet applied live. Decided while building: a link names the **plan** (not a plan revision), the operation code and the characteristic's stable key, so it survives plan revisions; the cause must hold the control being carried (prevention or detection); a link is made or ended on a draft or on the revision in force, **and when a newer revision is being prepared the work belongs there** (so the two never disagree); a new revision takes the live links with the causes that continue theirs, a copy from a base brings none; a link is ended with a reason, never deleted; the coverage is computed by plain functions from rows read as the caller, and a caller who cannot read control plans is told "not checked", never "covered")* | Carry a cause's control to a control plan characteristic, the coverage report (causes that need attention × the plan in force), the special class suggestion for the characteristic's criticality (offered, never copied), and a badge beside each plan characteristic naming the FMEA causes that carry a control to it. |
| **FM5b** *(built 2026-11-25; migration `20260443100000_fmea_occurrence_link.sql`, not yet applied live. Decided while building: the link is the column `fmea_failure_modes.ncr_failure_mode_id` (only a failure mode of the organisation's own register: not a sub failure mode, process or category; a switched-off one is kept but cannot be newly chosen; held for SQL too); it is copied into a new revision and into an FMEA started from a base (the register belongs to the organisation, not to a part); the counting is read **as the caller** by the API, not stored, over live non-conformances (not draft, cancelled or deleted) detected in the last 365 days (30–1095 on request); **scope** = the FMEA's part, part family (its parts) and machine links, matched on the NC's part, causal machine or detection machine, and with no such scope the counts are for the whole register and "not foreseen" is not offered (it would list everything); a non-conformance with no failure mode is counted apart, never called unforeseen; a caller who cannot read non-conformances is told the evidence is not available, never that none happened; the "look again" flag is a stated rule, not a model: highest occurrence rating of the failure mode's causes ≤ 3 against ≥ 3 non-conformances in scope, nothing is re-rated)* | Tie a failure mode to a failure mode of the NC register; the evidence card shows each failure mode beside its count, the ones nobody foresaw (with the newest examples as links), and the unclassified. |
| **FM5c** | Raise-from, risk link kind, change task kind, 8D D7 prompt, banners on part / plan pages — to build. |
| **FM6** | Outputs and signals: print form sheet, XLSX / CSV export, dashboard, reminders area, workflow triggers (`fmea.approved`, `fmea.action_overdue`, `fmea.review_due`), home page area, trace. |
| **FMX** | Exit check: live guardrails, advisors, journey step (PFMEA from a control plan's part → rate → action → approve → carry a control → an NC shows against its failure mode), exit report. |

## 8. Tests

Per slice: SQL test with deliberate breaks (frozen content, scoring, the approver rule, the "still needed" rules, cross-tenant ids; the AP grid coverage check), API e2e (+ both tenancy
sweeps, edit-conflict versions), pure unit tests for the compare / coverage / evidence, component tests, and the journey step in FMX. **Scoring is tested against the model, never against the
handbook's numbers, because the handbook's grid is not in the product.**

## 9. Not built (stated so it is not assumed)

A shipped failure mode or effect catalogue, automatic occurrence from SPC or NC data, an FMEA-MSR table, live inheritance (a child that changes when its base changes; FM17 is copy with provenance), a customer-specific
form template per OEM, supplier FMEAs submitted through the portal (PPAP slices), email to action owners (the notification path does it once the event exists), importing an existing
FMEA from Excel (a later import kind through the existing import engine).

## 10. Questions for the owner

| # | Question | Default if not answered |
|---|---|---|
| Q1 | **Answered: RPN with thresholds, import path kept.** **The AIAG-VDA AP grid and the S / O / D wording are the publisher's.** Do you hold a licence and want to **import the grid and the scale text** from your own copy (CSV), or do you want the module to ship RPN only? I could not confirm the grid from a public source, so I have not written it in. | RPN with thresholds until an AP grid is imported (FM5) |
| Q2 | One FMEA per **part**, or a **family / foundation** FMEA that a part's FMEA starts from? | **Answered: inheritance from a base FMEA, with the option to write one per part (FM17).** |
| Q3 | Should the **preparer ever be allowed to approve** (a switch like the change module's self-approval)? | **Answered: no; different person, always.** |
| Q4 | Is **design** FMEA wanted now or only process? | **Answered: both, one engine (FM1).** |
