# PPAP (production part approval process) — plan

**Status:** planned 2026-11-25; **PP1 and PP2 built** (migrations `20260447100000_ppap_foundation.sql` and `20260451100000_ppap_evidence_links.sql`, not yet applied live); decisions PP1–PP16 are **proposed** · **Depends on:** the FMEA module (`docs/fmea-plan.md`, built first: PPAP elements 4 and 6 point at an FMEA revision in force) ·
**Menu name:** PPAP (`BadgeCheckIcon`, to be checked in `components/icons`) · **Slices:** PP1–PP6, PPX (exit check)

Per `docs/design-brief.md` §3.5 (approval and revision history preserved), §6.5 and the Phase 4 pattern: complete, tested vertical slices, informing rather than blocking.
`docs/change-management-plan.md` left PPAP out and said "a PPAP submission package is a later use of the same [customer approval] field"; this is that use, as its own module.

## 1. What it is for

PPAP is the evidence a supplier gives a customer, before series production or after a significant change, that **the process can make the part to the drawing, at rate, repeatedly**.
Under AIAG PPAP (4th edition) a submission has up to **18 elements** and one of **five levels** (level 3, the full package, is the default), and the customer answers
**approved**, **interim approved** (with an expiry) or **rejected**.

A Fortress customer is usually **both**: a supplier to an OEM (they **submit** PPAP) and a buyer from their own suppliers (they **receive** PPAP). Almost every element of the package already
exists in Fortress as a record with its own approval and history. What is missing is **the one record that says "this package, for this part revision, went to this customer on this date, at this level,
and this is what they decided"**, and the prompts that say a part needs one.

A **PPAP submission** is that record:

- **what and for whom**: part and part revision, customer (or supplier, when received), site, reason for submission, level;
- **the 18 elements**, each Required / Not required / Not applicable by the level and the customer's own rules, each with its **evidence**, mostly **links to the live records with their status**, frozen when submitted;
- **the Part Submission Warrant (PSW)**, generated from the data, signed internally by a different person, frozen;
- **the customer's decision**, with their reference, interim expiry and note, recorded (or given by the customer in the portal);
- **what happens next**: interim expiry reminders, revalidation, and a banner wherever the part is worked on.

**Not:** APQP project management (phase gates, timing charts, feasibility), a full customer-specific-requirements engine for every OEM, a PLM or drawing vault, an automatic "PPAP passed" that
changes production, 3D / PLM data, sample shipment tracking, packaging approval workflows, a PPAP **template library** shipped for named OEMs (customer rules are the organisation's own, PP5).

## 2. Decisions (proposed)

| # | Decision |
|---|---|
| PP1 | **Two directions, one record** (`direction` `submitted` | `received`). **Submitted** (we send to a customer) is built first; **received** (a supplier sends to us) uses the same tables and the supplier portal and follows in PP5. |
| PP2 | **One submission per part revision, party and reason.** The reference is `PPAP-YY-NNNN` (`app.pad_number`). A resubmission after a rejection is a **new submission** that names the one it replaces; a rejected one is never reopened (its history stays). |
| PP3 | **Status**: `draft → in_preparation → ready → submitted → approved | interim_approved | rejected`, plus `withdrawn`; `interim_approved → approved | rejected | expired` (computed on read from the expiry date, never stored, like certificates). Moves are held by a trigger even for SQL. |
| PP4 | **The 18 elements are fixed** (a constant list in the database, `app.ppap_element_types()`, mirrored in the API and UI; labels are plain wording, not the manual's text): design records, engineering change documents, customer engineering approval, DFMEA, process flow diagram, PFMEA, control plan, MSA studies, dimensional results, material and performance test results, initial process studies, qualified laboratory documentation, appearance approval report, sample production parts, master sample, checking aids, customer-specific requirements, **Part Submission Warrant**. |
| PP5 | **Levels 1–5 decide what is required**, from a **requirement set** the organisation owns, in versions (a matrix of element × level: required to submit / retain / not required), seeded with a neutral default (§7 Q1) and **overridable per customer** (a customer that always wants dimensional results, or wants level 4). A submission freezes the version it used. |
| PP6 | **Evidence is a link first, a file second.** An element's evidence is one or more of: a **link** to a Fortress record (§4), a **controlled document** revision, or an **uploaded file** (private `ppap-files` bucket, like SCAR and quality alert files). A link stores the record's id **and the exact version used** so that what was submitted cannot be changed afterwards by editing the source. |
| PP7 | **Frozen at submission.** Submitting records, for every link, the version / revision id, its status and a content fingerprint (the way SPC baselines and GRR results freeze their data); a later change to the source shows as **"changed since submission"**, never silently. Files are frozen the same way (never deleted, a removed one keeps its row with a reason). |
| PP8 | **The PSW is generated, not typed twice**: part number, name, revision level and drawing date from the part revision, engineering change level from the change record, customer and purchase order, weight (typed), the manufacturing site, the reason for submission, the level, "results meet all requirements" and the declaration (typed), the signer's name, title, phone and date. The PSW freezes at submission and **prints** as a form. **The signer cannot be the preparer** (a different person with `ppap.approve`). |
| PP9 | **Readiness is a list, not a lock**: `app.ppap_problems(submission)` ("still needed": a required element with no evidence or no waiver reason, a linked record that is not in force or not approved, an inspection result out of tolerance, a capability below the agreed minimum, a PSW not signed) is shown and **a submission cannot be marked ready while it is not empty**; a waiver (with a reason, by an approver) clears a line. Nothing outside PPAP is blocked. |
| PP10 | **Acceptance criteria for studies are settings, not constants**: the minimum Cpk / Ppk for initial studies and for ongoing (the common 1.67 and 1.33 are the **defaults**, per customer overridable), the minimum number of readings, the MSA %GRR bands. Each element says plainly what it checked and what it used. |
| PP11 | **The customer's decision is recorded as an event**, append-only: submitted (date, how), approved, interim approved (expiry, conditions), rejected (reason), with their reference and a file (their signed PSW). The status and the part's current PPAP state are **worked out from the latest decision**. A customer in the portal can give it themselves (PP12). |
| PP12 | **Portal both ways**: a customer's people **see and answer** a submission in the portal (read the PSW and the evidence we chose to show, approve / interim / reject with a note and their reference) built like closure confirmation and change approvals (information only: it records their answer, nothing else moves); a **supplier's** people **submit** a PPAP package to us through the supplier portal (PP5 slice) which we review and decide on. Curated views, named fields only; tests list the exact keys. |
| PP13 | **Triggers are suggestions, never silent creation.** Fortress shows "this part revision may need PPAP" (on the part, on the change, on the control plan revision, on the supplier) when: a part revision is released for a part with a customer that requires PPAP; a **change** is approved with the type Product design or Material or supplier (or a task names a part revision); a **tooling / process** change names a machine on the part's control plan; a part has **not been produced for 12 months** (production orders); a new supplier source is linked for a part; a customer asks (a portal change request). A person starts it from the prompt (`app.ppap_draft_from(kind, id)`, the risk / change pattern), with the reason prefilled. |
| PP14 | **What it feeds**: the part and its revisions show the **PPAP state** (none, in progress, submitted, approved, interim until …, rejected); **Start inspection, the job hub and a production order** show a banner when the revision has no approved PPAP or an interim one is near expiry; **incoming inspection** for a supplier's part is **increased** until that supplier's PPAP for the revision is approved (a **suggestion** through the existing inspection recommendation, SQ6c, never an automatic change to a requirement); the supplier scorecard shows PPAP approvals as information. **Nothing blocks work** (the same decision as the change gate). |
| PP15 | **Permissions and packages**: `ppap.read`, `ppap.manage`, `ppap.approve` (sign the PSW, waive an element, record the customer's decision, approve a received package); owner, admin, quality manager all three; quality engineer read + manage; inspector, viewer read. **Observer = view, Contributor = view, Controller = full** (`features` rows; `app.unpriced_permissions()` unchanged). Errors `QM037` → `409 ppap_rule`; another organisation's id `P0002` → 404. Portal people have no permissions; their access is the portal's own live-access functions. |
| PP16 | **Direction of record-keeping**: for a **received** package the supplier's evidence is files and the supplier's own PSW values, our decision is the record, and the approval **feeds the supplier qualification** as an information line per part (never a status change; decision D3 of supplier quality stays). |

## 3. Data model (tenant tables: `organisation_id`, composite FKs, RLS, audit trigger, **no table writes: SECURITY DEFINER functions only**)

- `ppap_requirement_sets` — versions of the organisation's matrix: `rows` (element key × level 1–5 → `submit` | `retain` | `none`), `min_cpk_initial`, `min_cpk_ongoing`, `min_readings`, `max_grr_percent`, `reason`; **frozen**, valid per `app.ppap_requirement_problem`; a default seeded per organisation; changed only by `app.save_ppap_requirement_set(org, config, reason)` (`ppap.approve`, unchanged refused). `ppap_customer_rules` — per customer: default level, extra required elements, own minimums (replaced as a whole, audited, never deleted).
- `ppap_submissions` — `PPAP-YY-NNNN`, `direction`, `part_id`, `part_revision_id`, `customer_id` or `supplier_id` (exactly one by direction), `site_id`, `level` 1–5, `reason` (new part, engineering change, tooling, correction of a discrepancy, alternate material or supplier, process change, not produced for 12 months, customer request, other), `replaces_id`, `status`, `requirement_set_id`, the interim expiry and customer reference (from the latest decision), `origin_kind` + `origin_id` (never change), `client_key` (idempotent create, the SCAR pattern), `submitted_at/by`.
- `ppap_elements` — 18 rows per submission, made by the create function: `element_key`, `requirement` required | not_required | n_a (set from the level and the customer rules, editable by `ppap.manage`), `status` not_started | in_progress | ready | waived, `waiver_reason` + who (needs `ppap.approve`), note.
- `ppap_evidence` — per element: `kind` link | document | file; for a link the `target_kind` (control_plan_revision, fmea_revision, part_revision, change_request, inspection, msa_study, spc_capability, material_certificate, calibration, training / competence evidence, document_revision), `target_id`, `frozen_version`, `frozen_fingerprint`, `frozen_status` (set when the submission is submitted); a file's path, name, size (private bucket); removed with a reason, never deleted.
- `ppap_psw` — one per submission: the typed fields (weight, declaration, signer name / title / phone), the signer (member), the signed date; frozen at submission.
- `ppap_decisions` — append-only, frozen even for SQL: `kind` submitted | approved | interim | rejected | withdrawn | expired_noted, date, their reference, `expires_on` (interim), conditions / reason, a file (their PSW), recorded by (member) or by the customer (portal person).
- `ppap_portal_requests` (PP12) — the customer's pending question per submission (the CH6b shape): pending → answered | withdrawn, one pending per submission and customer party.
- `ppap_reviews` — a periodic revalidation record (due date from the level / the customer, `no_change` with a note or `resubmission_started`), append-only.

Functions (`SET search_path = ''`; `ppap.manage` unless said): `create_ppap` (makes the 18 elements, applies the level and the customer's rules, takes the model, idempotent by `client_key`), `update_ppap`, `set_ppap_level` (re-applies the requirement rules to elements not yet touched), `set_ppap_element`, `add_ppap_link` / `add_ppap_file` / `remove_ppap_evidence(id, reason)`, `waive_ppap_element(id, reason)` (`ppap.approve`), `mark_ppap_ready` (the "still needed" list must be empty), `sign_ppap_psw` (`ppap.approve`, never the preparer), `submit_ppap` (freezes every link and file, the PSW, the requirement set; writes the `submitted` decision), `record_ppap_decision` (`ppap.approve`), `withdraw_ppap(reason)`, `start_ppap_resubmission(id)` (new submission naming the replaced one, evidence links copied as **unfrozen** so they follow the current records), `record_ppap_review`, `ppap_draft_from(kind, id)`, `save_ppap_requirement_set`, `set_ppap_customer_rules`. Computed on read: interim expiry, "changed since submission", the PPAP state of a part revision (`app.part_ppap_state(part, revision)`).

## 4. What it connects to (existing modules, nothing rebuilt)

| Element | Source in Fortress |
|---|---|
| 1 Design records | the part revision (drawing letter and date) and any file |
| 2 Engineering change documents | the **change request** (ECR / ECN), approved |
| 3 Customer engineering approval | a file and the change's customer approval record |
| 4 DFMEA | the **FMEA** (design) revision in force |
| 5 Process flow diagram | the control plan's operations (a generated view) or a file |
| 6 PFMEA | the **FMEA** (process) revision in force |
| 7 Control plan | the control plan revision in force |
| 8 MSA studies | **Gauge R&R** studies for the gauges that measure the plan's characteristics (completed, in date) |
| 9 Dimensional results | **inspection records** for the part (a chosen set), with each reading's result |
| 10 Material and performance tests | **material certificates** (accepted) and uploaded test reports |
| 11 Initial process studies | the **SPC capability** (Cp / Cpk, Pp / Ppk) for the plan's SPC characteristics, against the minimum in the requirement set |
| 12 Qualified laboratory documentation | calibration records and a file |
| 13 Appearance approval report | a file |
| 14 Sample production parts, 15 Master sample, 16 Checking aids | a note, a file or a **gauge** record (checking aids are gauges) |
| 17 Customer-specific requirements | the customer's rules (PP5) and a file |
| 18 PSW | generated (PP8) |

Other connections: **change management** (a change shows "PPAP likely needed" and can **raise** one; a change task may name a PPAP submission; the change's customer approval is the element-3 evidence), **portal** (PP12), **supplier quality**
(received packages; the expiry watchlist shows interim approvals; the profile gets a PPAP tab), **production orders and lots** (banner, and the lot trace page lists the PPAP the lot ran under), **workflow and reminders** (`ppap.submitted`, `ppap.approved`,
`ppap.rejected`, an interim expiring, a revalidation due), **home page and dashboard**, **risk register** (a rejected submission can be raised as a risk), **documents** (a PPAP package can be exported as a controlled PDF set later).

## 5. API (`api/src/ppap/`, `@Versioned` on submissions)

`GET|POST /ppaps` (page-based: `q`, `status`, `direction`, `customerId`, `supplierId`, `partId`, `level`, `expiring=true`, `owner=me`, sort), `GET|PATCH /ppaps/{id}` (the whole submission: elements with evidence and live state, problems, PSW, decisions, `canApprove`),
`PUT /ppaps/{id}/level`, `PATCH /ppap-elements/{id}`, `POST /ppap-elements/{id}/evidence|waive`, `POST /ppap-evidence/{id}/remove`, `POST /ppaps/{id}/ready|sign|submit|decisions|withdraw|resubmission|reviews`, `GET /ppaps/{id}/psw` (the printable data),
`GET /ppap-candidates?kind&partId` (records that could be linked for an element, read as the caller), `GET /ppaps/linked?kind&id` (for banners and cards), `GET /part-ppap-state?partId&revisionId`, `GET /ppap-draft?kind&id`,
`GET|PUT /ppap-requirements` (versions), `GET|PUT /ppap-customer-rules/{customerId}`, `GET /ppap-dashboard`; portal (`@PortalScoped`): `GET /portal/ppaps`, `GET /portal/ppaps/{id}`, `POST /portal/ppaps/{id}/decide`, and for suppliers (PP5) `POST /portal/ppaps`
with `…/files`. The live state of an evidence link (in force? out of tolerance? capability?) is worked out by pure functions with unit tests, read as the caller so a link to a record the person cannot read shows **"not available"**, never a blank pass.

## 6. UI (`src/components/ppap/`)

Menu **PPAP**: Dashboard, **Submissions** (register in the usual pattern), **Requirements** (Settings → Data Management → PPAP: the matrix, the minimums, customer rules). The submission page shows a **checklist of the 18 elements** (requirement,
status, evidence count, live status from the linked records, "changed since submission"), an element panel (add a link from `ppap-candidates` with a combo that shows the record's own status, or drop a file, or waive with a reason), a **Still needed** list,
the level and reason, the PSW card (typed fields, sign), the lifecycle bar (ready, submit, record the customer's decision, withdraw, resubmit), the decisions history, and **Print** (the PSW form and a cover sheet listing the evidence). Banners on the part page,
Start inspection, the job hub, the production order and the change page use one shared `PpapBanner` (information only). Every answer is also in words; colours are the `--chart-*` status colours.

## 7. Slices

| Slice | Content |
|---|---|
| **PP1** | Foundation: permissions, packages, module, requirement sets (versions, default), `ppap_submissions` + 18 elements + lifecycle, level and reasons, register, submission page with the checklist and file evidence, menu, tests. |
| **PP2** (built) | Evidence links to the live records (the table in §4) with live state and freezing at submission, the "still needed" list, waivers, `ppap-candidates`. Built as: `app.ppap_link_kinds` (element → kinds), `add_ppap_link`, `ppap_link_state` (read as the caller; `available: false` when they cannot read it), `ppap_freeze_links` (internal, called by PP3's submit; frozen label, status, version and content fingerprint, "changed since" compares the live fingerprint), `ppap_candidates`; the API judges the statistics (Ppk against the minimum for initial studies and the number of readings, %GRR against the largest acceptable) with the customer's own minimums over the organisation's, and `markReady` refuses on them. A design FMEA is the evidence for element 4 and a process FMEA for element 6. Not built: opening the linked record from the submission (the state carries no parent ids), judging a type 1 or attribute study beyond its own verdict. |
| **PP3** | PSW (generated, signed by a different person, printed), submit, the customer's decision events, interim expiry, withdraw, resubmission, periodic revalidation, notices. |
| **PP4** | Customer portal: a customer sees and answers a submission (curated view, decision recorded as the CH6b pattern), home attention, email. |
| **PP5** | Received direction: the supplier portal submits a package, our review and decision, supplier profile tab, expiry watchlist line, inspection recommendation input; customer rules per customer. |
| **PP6** | Triggers and signals: "PPAP likely needed" prompts and raise-from (part revision, change, control plan revision, machine, 12 months idle), banners, workflow triggers, reminders, home area, dashboard, trace. |
| **PPX** | Exit check: live guardrails, advisors, journey step (a part with a control plan, FMEA, inspection and Gauge R&R → level 3 submission → PSW signed → customer approves in the portal → banner changes), exit report. |

## 8. Tests

Per slice: SQL test with deliberate breaks (frozen evidence, the signer rule, the requirement rules, the status moves, cross-tenant ids), API e2e (+ both tenancy sweeps), pure unit tests for the live-state functions, component tests,
and the journey step in PPX. The curated portal views list their exact keys in the SQL test and the e2e test, as the other portal views do.

## 9. Not built (stated so it is not assumed)

APQP phases and timing, OEM-named templates, sample shipment tracking, a PPAP package as one downloadable PDF set (a later export), automatic resubmission, an approved-PPAP **gate** on production (PP14: informs only), electronic signature
beyond the named signer and date, customer-specific form layouts, importing an old package from a spreadsheet.

## 10. Questions for the owner

| # | Question | Default if not answered |
|---|---|---|
| Q1 | The level × element requirement matrix and the minimum Cpk values are **customer-specific** and the manual's own table is the publisher's: do you want to enter your own, or start from the neutral default (level 3 = every element, level 1 = PSW only)? | **Answered 2026-11-25: neutral default, editable (PP5).** |
| Q2 | Are your customers mostly **automotive (AIAG)**, or also aerospace (AS9145 / FAI to AS9102)? FAI is a different, simpler record. | **Answered: AIAG only; FAI is a later module.** |
| Q3 | **Received** packages (suppliers submitting to you) at the same time, or after the submitted side is working? | **Answered: after (PP5).** |
| Q4 | Should an unapproved PPAP ever **stop** a job or a shipment? | **Answered: no (PP14, the same call as the change gate).** |
