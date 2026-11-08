# Audit Management specification — gap analysis and phased plan

**Source:** `fortress_audit_management_implementation_spec.md` (the "spec", supplied 2026-11-08) · **Against:** the audit module as built (AU1–AU3 live, AU5 built; `docs/audits-plan.md`) · **Status:** proposal — **nothing in this document has been built**; the order and the open decisions in §4 need agreeing first.

The spec describes a *configurable, version-controlled audit engine*. What exists today is a smaller, working slice: **audit definitions** (a checklist, a schedule and what the audit is relevant to, all in one record), **a schedule**, **audit records** (one audit carried out, with answers and a computed result) and **ten response types**.
The spec says to reuse what exists and make the smallest safe adaptation, to implement in phases, and not to build every advanced capability in one pass. This analysis follows that.

## 1. Where the current module already meets the spec

| Spec | Today |
|---|---|
| §6.3 ten response types, validated and structured | **Done (AU5).** Yes/No, Compliant, Pass/Fail, Yes/No/N/A, Numeric, Text, Multiple choice, Measurement, Evidence, Rating — each validated by the database, scored by its type, frozen into the record. |
| §6.4 comment required on a failure; "the auditor sees why a field is required"; a failure is **not** automatically an NC | **Done.** A failed answer needs a note; the "Still needed" list says what is missing; an NC is raised only on request. |
| §7.3 save as you go, resume, validate before completing, progress | Answers save as they are given (optimistic, rolled back on error); an in-progress record can be resumed; completion is refused with the reasons. No section grouping and no progress counts yet. |
| §7.2 scope: several machines / operations / departments | **Done** as `audit_targets` (the audit lists them) and `audit_record_targets` (the record says which it covered). |
| §8.3 raise an NC from a failure, never twice | Partly: `app.raise_ncr_from_audit` makes a **draft internal NC** from failed answers, one live NC per failed answer, linked in `audit_ncr_links`. There is no *finding* in between and the NC has no audit source fields. |
| §9 status lifecycle with history | Partly: records are `in_progress → completed | abandoned`; every change is in the audit trail (`audit.events`). |
| §11.1 tenancy, RLS, permissions server-side; §11.3 evidence in storage with tenant-safe policies | **Done** (RLS on every table, SECURITY DEFINER writers, private `audit-files` bucket, evidence never deleted). |
| §12.2 a completed audit cannot be silently edited | **Done** (frozen once completed). No amendment / reopen process yet. |
| §5.1 recurring schedule, overdue tracking, programme progress | Partly: slots from a frequency, upcoming / overdue / missed / done, skip with a reason, pass and on-time rates. No programme object, no rescheduling with a reason, no risk scoring. |
| §12.1 versioned templates | **Not met by design today**: a definition is edited in place; records keep a frozen copy of the questions (so history is safe) but there are no published versions. |

## 2. Gaps, by spec section

| # | Spec | Gap | Size |
|---|---|---|---|
| G1 | §6.1–6.2 reusable **templates**, **sections**, versions (draft / active / archived), duplicate / reorder sections and questions | No template library; a definition holds its own flat checklist; no sections; no versions. | **Large** |
| G2 | §6.3 numeric / measurement precision, "flag if outside limits" setting | Limits exist; decimal precision and the flag setting do not. | Small |
| G3 | §6.4 rules: evidence required for selected responses, N/A needs a justification, conditional questions, a configured critical failure **must** create a finding | Only "note on failure" and "evidence question needs a file". | Medium |
| G4 | §7.1 audit creation: **lead auditor, additional auditors, auditees**, scope text, objectives, criteria, site, process(es), planned date range, linked records | Records have only who started / completed them; the expected auditor is a hint on the definition. No participants, objectives, scope text, site or process. | **Large** |
| G5 | §7.2 / §11.2 **flexible scope references** (machines, operations, parts, part revisions, lots, work orders, suppliers, documents…), allow-listed server-side | Machines, operations, departments only. | Medium |
| G6 | §8 **findings**: classification (major NC, minor NC, observation, OFI; extensible), standalone findings, evidence, owner, status, repeat-finding link; **promotion to the existing NC workflow**, idempotent, NC carries source audit + finding; corrective actions via the existing CAPA module | No findings entity at all. NC raising is direct from an answer. The NC has no `source` = audit and no source audit / finding reference. | **Large** |
| G7 | §9 / §12.2 workflow **Draft → Planned → Ready → In Progress → Pending Review → Approved → Closed (| Cancelled)**; reviewer approve / reject; controlled amendment / reopen with reason; auditee acknowledgement distinct from approval | Only in progress / completed / abandoned. No review, approval, reopen, amendment, acknowledgement. | **Large** |
| G8 | §7.5 / §14 **report**: audit summary, PDF generated from an immutable snapshot at approval | None. (The CAPA 8D report page, `CapaReportPage.jsx`, is the pattern: a print view, "Print or save as PDF".) | Medium |
| G9 | §10 **criteria library**: sources, editions, clauses, requirements, parent / child, many-to-many with questions; no copyrighted text seeded | None. | Medium–Large |
| G10 | §5 **audit programme**: programmes, planned items, owner, date window, reschedule with reason, recurring generation, **risk-based priority** with configurable factors and a recorded rationale | Frequency-based schedule only; no programme, no risk scoring. | **Large** |
| G11 | §4 / §14 **dashboard and reports**: KPIs, planned vs completed, findings by classification / department, trend, overdue actions, repeat findings, audit history for a scope item | Only the schedule's counts. | Large (and depends on G6, G7, G10) |
| G12 | §13 permissions: view, create, edit draft, execute assigned, manage templates, **publish** template versions, manage programmes, classify findings, promote to NC, **review / approve**, close / reopen, view reports | Three permissions: `audits.read`, `.manage`, `.perform`. | Medium |
| G13 | §2.3 / §17 **product audit** loading characteristics from the effective inspection plan (part revision, plan version stored, limits evaluated) | None. Reusable: the requirement resolver `app.resolve_inspection_requirements`. | Large, later |
| G14 | §2.4 **LPA**: auditor levels, shifts, escalation of repeated failures, completion by level and period | Partly (frequency, short checklists); no levels, shifts, escalation. | Medium, later |
| G15 | §2.7 **supplier audits** from the supplier record | None; the audit is not linkable to a supplier. | Small–Medium, later |
| G16 | §6.2 conditional visibility, §7.3 section completion counts, tablet layout | None. | Medium |

## 3. How the existing model maps to the spec (the smallest adaptation)

The spec's logical model and ours are close enough to evolve rather than replace:

| Spec entity | Today | Proposed adaptation |
|---|---|---|
| `audit_templates` + `audit_template_versions` | `audit_definitions` + `audit_questions` (one editable row) | Make a **template** the identity and add immutable **versions**; sections and questions belong to a version. A published version never changes; editing makes a new draft version. The schedule (frequency, grace, expected auditor) moves to the programme item (G10) or stays on the template until then. |
| `audit_template_sections` / `_questions` | `audit_questions` (flat, with `sequence`) | Add `audit_template_sections`; a question belongs to a section of a version. |
| `audits` | `audit_records` | An **audit** is created from a **template version** with scope, objectives, criteria, planned dates and participants, and runs through the workflow statuses. `audit_records` becomes the audit; its frozen question copy already satisfies "the audit stores what happened". |
| `audit_responses` | `audit_responses` | Unchanged (already typed and scored). |
| `audit_findings` | — | New. Replaces the direct "raise NC from an answer"; the existing `audit_ncr_links` becomes finding ↔ NC. |
| `audit_participants` | — | New (lead auditor, auditors, auditees, role per participant). |
| `audit_evidence` | `audit_attachments` (evidence questions) | Extend to findings and to any response. |
| `audit_scope_references` | `audit_targets` / `audit_record_targets` | Generalise to an allow-listed set of entity types. |
| `audit_programmes` / `_items` | `audit_occurrences` (generated slots) | New programme objects; slots become programme items. |
| `audit_criteria_sources` / `audit_criteria` / links | — | New. |
| NC and CAPA | `nonconformances`, `capas` | **Reuse as they are.** Add NC source `internal_audit` / `supplier_audit` with audit and finding references; start an 8D from the NC through the existing flow. No second corrective-action engine. |

Constraints to keep: migrations are incremental and reversible; every new table gets RLS, `organisation_id`, an audit trigger, the guardrails and both sweeps; writes are SECURITY DEFINER functions; the audit trail is `audit.events`; permissions are new `audits.*` codes (not `audit.*`); not subscription-gated unless asked.

## 4. Proposed phases (each a complete, tested vertical slice)

The spec's own phases are used, re-cut so that each one works on what exists and nothing is wasted:

| Phase | Contents | Spec gaps | Why this order |
|---|---|---|---|
| **A. Findings and NC integration** | `audit_findings` (classification table, standalone findings, owner, status, evidence), "Create finding" from an answer, **Create nonconformity** from a finding (idempotent, NC source = internal / supplier audit, source audit and finding on the NC, evidence carried), findings tab and register, finding rules (§6.4: a configured critical failure must produce a finding). | G6, part of G3 | Smallest step with the most value; it works on today's records and removes the temporary "raise NC from an answer". |
| **B. Audit workflow, participants and approval** | Lead auditor / auditors / auditees, objectives, scope text, criteria text, site, planned dates; status lifecycle **Draft → Planned → Ready → In Progress → Pending Review → Approved → Closed / Cancelled** with reasons; reviewer approve / reject; controlled amendment / reopen; auditee acknowledgement; report page with print / PDF and an immutable snapshot at approval; permissions split (review / approve / close). | G4, G7, G8, G12 | Turns "a record" into an "audit". |
| **C. Template engine** | Templates with sections and **versions** (draft / published / archived), template library and builder (duplicate, reorder), audits created from a published version; existing definitions migrated to template v1; response-rule options (G2, G3); section grouping and progress in the checklist (G16). | G1, G2, G3, G16 | The largest change; easier once audits are a proper object (B). |
| **D. Criteria library and flexible scope** | Criteria sources / clauses, links from questions and findings, allow-listed scope references (parts, part revisions, lots, work orders, suppliers, documents). | G9, G5 | Needs templates (C) and findings (A). |
| **E. Audit programme and dashboard** | Programmes and items, rescheduling with reason, recurring generation, risk scoring with a recorded rationale, dashboard and reports (planned vs completed, findings analysis, repeat findings, history for a scope item). | G10, G11 | Needs A–D to have anything worth reporting. |
| **F. Methodology integrations** | Product audit loading the effective inspection plan; LPA levels, shifts, escalation; supplier audits from the supplier record. | G13, G14, G15 | Each reuses an existing module; last, as the spec says. |

## 5. Decisions needed before building

1. **Which phase first.** Recommendation: **A**, then **B** (they make today's module a proper audit workflow without restructuring data), then **C**.
2. **Templates versus definitions (C).** Recommendation: evolve `audit_definitions` into templates with versions and migrate the existing ones to version 1 (no live audits exist yet, so the migration is small). The alternative — building templates alongside definitions — leaves two checklist editors.
3. **Where the schedule lives after C/E.** Recommendation: keep the current frequency-based schedule until programmes (E), then turn its slots into programme items.
4. **Finding classifications.** Recommendation: a per-organisation table seeded with major NC, minor NC, observation and OFI, editable.
5. **Report.** Recommendation: a print-to-PDF report page (as the 8D report) built from a stored snapshot at approval, rather than a server-side PDF renderer.

## 6. Not in the spec and not proposed

Auditor competence checks, customer / certification-body audits with certificates, per-question score weights and a multi-select multiple choice remain out of scope (see `docs/audits-plan.md` A8 and §10).
