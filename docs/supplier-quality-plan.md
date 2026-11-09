# Supplier Quality — review of the spec and implementation plan

Source: `fortress_supplier_quality_implementation_spec.md` (22 sections). This is **Phase 0 (discovery) of the spec**: what exists, what is missing, what to reuse, the
decisions needed, and the proposed slices. Nothing here is built yet; each slice is agreed before it starts (brief §14, CLAUDE.md).

## 1. What already exists (checked in the repo)

| Spec needs | What Fortress has today | Verdict |
|---|---|---|
| One central supplier register | `public.suppliers` (migration `20251104120000`): `code`, `name`, `display_name`, `company_number`, `vat_number`, `notes`, `active`; RLS, `audit_changes`, no deletes, gated by `master_data.read/.manage`. Register page `PartiesPage.jsx` (`/Suppliers`), API in `api/src/master-data/`. | **Extend.** `active` already is the "operational activity" the spec wants kept separate from approval. Missing: type, address/country/website, contacts, classifications, approval status + history, risk. |
| Central NC system | `nonconformances` with `source` (`supplier`, `goods_receiving`), `supplier_id`, `lot_id`, affected lots, containment, dispositions, stage gates, category. | **Reuse as is.** Detection source and responsible supplier are already separate fields. Gap: no *receipt* link (see lots below). |
| Corrective-action engine | `capas` (8D, one record, steps D0–D8, team, actions, verification, NC links many-to-many). It is the **internal** 8D. | **Reuse for Fortress's own actions.** The SCAR (external request/response) is genuinely new; it links to NCs and optionally to an 8D. |
| Inspection engine | `inspection_records` via `app.start_inspection(site, part, operation, machine, …)`; control-plan resolver; samples/measurements; NC raising; lot/order/serial links (`set_job_links`). | **Reuse.** Gaps: no supplier/receipt context, no "incoming" trigger type or operation, no sampling schemes (AQL, skip-lot, percentage). Requirements come from control plans, not from supplier rules. |
| Audit engine | `audit_definitions` (questions, versions), schedule, records, findings → NC. `audit_targets.kind` is `machine | operation | department`. | **Reuse; extend.** Needs a `supplier` target kind (definition, versions hash, schedule filters, record targets, dashboard coverage). |
| Document control + evidence storage | **No Document Control module exists.** The pattern in use is per-record attachment tables (functions-only writes, never deleted, private bucket, path `<org>/<area>/<id>/<uuid>-<name>`): NC, calibration, quality alert, CAPA, audit. | **Gap.** See decision D2. |
| Purchase orders, goods receipts, materials | **None.** NCs carry a typed `purchase_order` text. `lots` (`origin='received'`, `supplier_id`, `quantity`, `received_on`, `site_id`, hold/release) is the nearest thing to a receipt. Parts exist; materials do not. | **Real gap** and the main design risk (OTD, PPM, incoming flow all need it). See decision D1. |
| Part / part family / lot / serial / production order | Present and linked (`lots`, `serial_numbers`, `ncr_affected_lots`, traceability page). | **Reuse.** |
| Permissions vs entitlements | RBAC (`permissions`, roles, `app.has_permission`) separate from subscription (`modules`, `features`, `app.check_entitlement`). `modules` already lists `supplier_quality` as `planned`. | **Reuse.** Add `supplier_quality.*` permissions and features; flip the module to `active` when the first slice ships. |
| Notifications | `emit_notification` trigger on `audit.events`, event catalogue, per-user preferences, `recipient_user_id` for personal notices. | **Reuse.** Event-driven only. |
| Scheduled work | **No worker.** Overdue/expiry is computed on read; the only crons are billing (`api/vercel.json`, production deployment only). | Constrains expiry and due-date notifications. See decision D3. |
| Register/table/filter conventions | `TableWrapper`, column menu, filter drawer, header search, saved filters (`SavedFilterBar`), `CTAButton`, `DropdownMenu`, `ComboField`, optimistic hooks, `refreshOrganisation`. | **Reuse everything.** No second visual language. |
| Tenancy rules | Composite `(id, organisation_id)` FKs, RLS on every table, functions-only writes for controlled records, audit trigger, guardrails + both sweeps, error codes `QMxxx → 409 xxx_rule`. | Every new table follows this. |

## 2. Where the spec and the repo disagree (called out, not hidden)

1. **Document Control is assumed but absent.** The spec says "integrate with existing Document Control". There is none; only attachment tables.
2. **Purchasing/receiving is assumed but absent.** The spec says "reuse existing goods-receipt models". There are none. `lots` is the only receipt-like record.
3. **Materials are assumed but absent.** Only parts exist. Material certificates therefore link to a part + received lot + heat/batch number for now.
4. **"One corrective-action engine"** — the 8D is a team method for Fortress's own investigation. A SCAR asks an *external* party and tracks their response; forcing it into the 8D steps would be wrong. It reuses the NC links, the actions/ownership patterns and may link to an 8D.
5. **Phase order.** The spec orders Performance (phase 4) before Incoming Quality (phase 5), but PPM and OTD need received quantities and promised dates. I propose building receipts first (§5).
6. **The brief (§15) says don't build future phases early.** Supplier quality is listed in the brief's "broader QMS modules"; since you are directing it, I treat it as agreed scope, one slice at a time.

## 3. Decisions needed before the slices that depend on them

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Receiving model (blocks OTD, PPM, incoming inspection) | (a) Add minimal `purchase_orders` + `purchase_order_lines` + `goods_receipts` (+ lines, each pointing at a `lot`); (b) receipts only, no PO (promised date typed on the receipt); (c) use `lots` alone and defer OTD | **(a) minimal**: one PO with lines (part, quantity, requested date, agreed date), receipts per line with received quantity, lot, date, site. No pricing, no approvals, no ERP sync (Phase 5 of the brief reserves `external_system/external_id`). Without a promised date there is no honest OTD. |
| **D2** | Supplier documents without a Document Control module | (a) `supplier_documents` on the existing attachment pattern (metadata, expiry, verification, type/revision, private bucket), designed so a later Document Control module can adopt it; (b) wait for Document Control | **(a).** Same safety properties as every other attachment table. |
| **D3** | Expiry / due-date notifications with no worker | (a) computed on read plus an in-app watchlist, notification written when a person opens the area or via the API cron where enabled; (b) add a daily cron job like billing's (production deployment only) | **(a) now, (b) when a real worker exists.** The spec's rule that expiry must not auto-suspend holds either way. |
| **D4** | Who may approve a supplier | New permission `supplier_quality.approve` (owner, admin, quality manager); the preparer may not approve their own assessment? | Separate permission; **preparer ≠ approver** (stricter than NC dispositions, as approval changes purchasing behaviour). Say if you want the NC rule (preparer may approve). |
| **D5** | Supplier users / portal | Out of scope now | Keep every SCAR/response table portal-ready (no internal-only fields mixed into response rows, supplier contacts as separate rows) but build no external identity. |
| **D6** | Placement | Keep the register at `/Suppliers` under Master Data and add a Supplier Quality menu group (Dashboard, Register, Qualification, Performance, Incoming, NCs/SCARs, Audits, Documents); or move the register | Keep `/Suppliers` (old links keep working) and have the group link to it. |

## 4. Architecture principles for every slice

- Extend `suppliers`; never a second supplier table. Approval status is a new column with an append-only history; `active` stays the operational flag.
- Controlled records (approvals, assessments, risk assessments, scorecards, SCAR responses, certificates) are **append-only with history**: written by SECURITY DEFINER functions that check permission, tenant and transition rules, never deleted, audited (`audit_changes`).
- Transitions are table-driven and enforced in the database (like NC stages, 8D steps), with the API mirroring them for friendly messages.
- Configurable things (assessment templates, scoring weights, bands, risk factors, inspection rules, OTD date policy) are rows per organisation with a **version** stamped on every result, so history never rewrites (the audit-versions pattern).
- Every new table: organisation-scoped composite FKs, RLS, `app.stamp_created`, column-level UPDATE, no DELETE, audit trigger, entries in `guardrails.test.sql` and both tenancy sweeps; every new route `@OrganisationScoped` with a sample body for the sweep.
- Performance numbers come from live records, defined in one place (`api/src/supplier-quality/metrics.ts`, pure functions like `spc.ts`), with explicit handling of partial, cancelled and missing deliveries, and "insufficient data" instead of a misleading score.
- Optimistic UI for small saves, `refreshOrganisation` after every mutation, `CTAButton`/`DropdownMenu`/`ComboField`/`TableWrapper` everywhere.

## 5. Proposed slices (each complete, tested, agreed before it starts)

Order differs from the spec only where a dependency forces it (§2.5).

### SQ1 — Register and profile *(spec phase 1)*
- Migration: `suppliers` gains type, trading name, country, address, website, purchasing reference, `approval_status` (`pending_approval | approved | conditional | suspended | disqualified | archived`, default `pending_approval`, never implied), `risk_rating` placeholder; `supplier_status_history` (who, when, reason, from → to; validated transitions by function `app.change_supplier_status`); `supplier_classifications` (organisation-configurable) + `supplier_classification_links` (multi-select); `supplier_contacts` (roles); `supplier_product_links` (supplier ↔ part, with customer-part style reference; materials/services as typed text until a materials model exists).
- Permissions `supplier_quality.read/.manage/.approve` (and `.configure`), module → active, features mapped.
- API `api/src/supplier-quality/` (register page-based with search, sort, filters: status, type, classification, active, site later; profile; status change; classifications; contacts; product links).
- UI: register upgraded to the standard table (columns, filter drawer, header search, chips, saved filters, CSV), **Supplier profile** page with the nine tabs (Overview, History live; others show what is coming), status actions by permission with reason dialogs, menu group.
- Exit: cross-tenant and permission tests, transition tests, history tests, journey step.

### SQ2 — Qualification and documents *(spec phase 2)*
- Assessment templates (versioned; question types as the audit engine, plus evidence-required and weights), assessments (frozen copy per run), responses, evidence; **approval decisions** table (append-only: decision, rationale, conditions, approver, effective/review/expiry dates); certifications (type, number, body, scope, dates, verification, evidence) with computed expiry state; `supplier_documents` (D2); initial risk assessment (configurable factors, thresholds, review interval; historical rows). Approval needs `supplier_quality.approve` (D4). Expiry surfaces as warnings and watchlist items, **never auto-suspends**.
- UI: guided qualification flow, certifications and documents tabs with expiry badges, risk assessment with visible rationale.

#### SQ2 broken into three agreed-by-default pieces (decisions D2, D3, D4 taken as recommended above: documents on the attachment pattern, expiry computed on read with no auto-suspend, **preparer ≠ approver**)

- **SQ2a — Certifications and documents (this step).** `supplier_documents` (type, title, revision, document date, optional expiry, one stored file in the private `supplier-files` bucket at `<org>/supplier/<supplier id>/<uuid>-<name>`; verified by a person with a note; a new version replaces the old, which stays as superseded; removed with a reason, never deleted) and `supplier_certifications` (type, number, issuing body, scope, issued and expiry dates, optional evidence document, verified by a person; renewal makes a new row and supersedes the old; withdrawn with a reason, never deleted). Expiry is **computed on read** (valid / expiring in 60 days / expired / no expiry) and **never changes a supplier's approval status**. API: lists and commands on the profile, an **expiry watchlist** across suppliers (`GET /supplier-quality/expiry-watchlist?days`). UI: Qualification tab (certifications) and Documents tab live on the profile, an Expiry watchlist page under Supplier Quality, expiry badges.
- **SQ2b — Risk assessments.** Configurable factors, weights and band thresholds with a version stamped on every result, historical rows kept, review interval; the result is the only thing that writes `suppliers.risk_rating`; rationale shown.
- **SQ2c — Qualification: assessments and approval decisions.** Versioned assessment templates (audit-engine question types plus evidence-required and weights), assessments run as a frozen copy, responses and evidence, scoring; an append-only **approval decision** (decision, rationale, conditions, effective/review/expiry dates) written by a function that needs `supplier_quality.approve` and refuses the preparer of the assessment; the decision moves the status through `app.change_supplier_status` so the status history stays the single record.

### SQ3 — Supplier NCs and SCARs *(spec phase 3)*
- Supplier-filtered views over central NCs (profile tab and a Supplier NCs register: detection source vs responsible supplier vs affected lots); NC ↔ receipt link once SQ4 lands.
- `supplier_scars` + `supplier_scar_ncrs` (one SCAR, many NCs) + `supplier_scar_responses` (revisions) + status history; the ten statuses with validated transitions; receipt of a response never closes; separate **supplier response**, **internal review**, **implementation** and **effectiveness verification** records; due-date extensions; optional link to an 8D for Fortress's own actions; idempotent creation (client key). Notifications for due/overdue/response received.
- UI: SCAR register and detail with the stages kept visually distinct, "Raise SCAR" from an NC.

#### SQ3 as built (split into SQ3a–d; statuses agreed by the user because the spec file was unavailable)
- **SQ3a** supplier NC view on the profile (no migration). **SQ3b/c** one migration `20251229100000_supplier_scars.sql`: SCARs, NC links, responses, reviews, implementations, verifications, extensions and status history; ten statuses `draft, issued, acknowledged, response_received, under_review, revision_requested, accepted, verifying, closed, cancelled`; receiving a response never closes; closing needs an effective verification by `supplier_quality.approve`; creation idempotent per client key; overdue computed on read. **SQ3d** register, detail page with the five stages kept apart, Raise SCAR from the NC page, profile tab. **SQ3e** (after the spec arrived) added requirement breached, objective evidence, containment requirements, internal owner, affected items, the supplier's extent of condition / escape point / responsible person / method, and approval of due-date extensions by a different approver. Not built: notifications, files, dashboard.

### SQ4 — Receiving and incoming quality *(spec phase 5, brought forward)*
- Per D1: minimal purchase orders, receipts, receipt lines linked to `lots`; receipt register and rejection → NC raising with the receipt/lot attached.
- `supplier_inspection_requirements` (rules by supplier / part / family / classification / risk / customer; strategy: 100%, first-off, fixed sample, percentage, AQL, skip-lot) with approvals and level-change history; **critical, safety or customer-controlled parts can never be reduced by an unapproved rule**. Incoming inspections run through the shared inspection engine (new trigger type `incoming`, receipt/supplier context on `inspection_records`, resolver gets the sampling from the rule); material certificates (`supplier_material_certificates`) linked to part + receipt + lot + heat number.
- This is the largest slice and will itself be split (SQ4a receipts, SQ4b requirements/engine hook, SQ4c certificates) when we reach it.

#### SQ4 split and SQ4a as built
- **SQ4a** (decision D1 (a), taken): `purchase_orders`, `purchase_order_lines` (original requested date kept, latest agreed date changeable), `goods_receipts`, `goods_receipt_lines`; a line with a lot number makes the received lot; functions only; late/outstanding computed on read; permissions `receiving.read/.manage`. **SQ4b** next: inspection requirements by supplier / part / family / classification / risk, incoming inspection through the shared engine (trigger `incoming`, receipt context), rejection → NC with a receipt link, reduction of controls only by approved rules. **SQ4c** (as built): `supplier_material_certificates` linked to supplier + part/material + receipt line + lot + heat number, a supplier document as the file, recorded by receiving staff and accepted or rejected once by a quality manager; information on the receipt line, no gate yet.

### SQ5 — Performance *(spec phase 4, after receipts)*
- Metric definitions in pure code (PPM from received/rejected units, lot rejection rate kept distinct, OTD with configurable original-vs-agreed date policy, NC counts/severity/repeat, SCAR responsiveness, certification validity, document completeness), configurable weights/bands, **stored scorecard snapshots** (period, values, config version, band, warnings) that never change, trends, supplier dashboard and **watchlist** where every warning drills to its source and says why.

#### SQ5 as built
- One migration `20260103100000_supplier_performance.sql`: the **database** works out the metrics, score, band and warnings (`app.supplier_performance`), so a saved scorecard, the live tab and the watchlist share one definition; the model is versioned per organisation; scorecards are frozen snapshots. The API only reads and reshapes (no `metrics.ts`). UI: Performance tab, watchlist page, scoring model in Settings. Document completeness is not a metric yet.

### SQ6 — Audits, reports, advanced *(spec phase 6)*
- `supplier` as an audit target kind across definitions, versions, schedule, records and the audits dashboard; supplier-filtered audit tab with findings → NC links; risk-based inspection **recommendations** (never automatic weakening); reports/exports with period, definitions and calculation timestamp; portal readiness notes only.

#### SQ6 as built
- **SQ6a** `supplier` as an audit target kind (migration `20260104100000_supplier_audit_targets.sql`, fingerprints of existing audits unchanged); **SQ6b** the profile Audits tab; **SQ6c** an information-only inspection recommendation from risk, approval status and performance (pure rules, never writes); **SQ6d** read-only report endpoints and a CSV export that carries the period, definitions, scoring basis and generation time. Portal readiness: no external identity was built; response tables stay free of internal-only fields. Supplier audit coverage on the schedule is not built.

## 6. Cross-cutting acceptance (from spec §21), mapped
Tenant isolation and permission checks on every endpoint → sweeps; status transitions → SQL and API tests with mutation checks; history preserved → append-only tests; PPM ≠ lot rejection → pure-function tests; OTD policy → tests per policy; snapshots stable → test that later changes do not alter old snapshots; critical controls cannot be reduced → rule tests; retries create no duplicates → idempotency tests; dashboard/profile queries without N+1 → single aggregate queries, checked in e2e.

## 7. Risks
- **D1 is the big one.** Building receipts is new domain code, not just supplier code; keeping it minimal protects the schedule. Skipping it makes OTD/PPM impossible.
- Extending `audit_targets` touches the audit versions fingerprint and the dashboard coverage queries; SQ6 needs the audit tests re-run and its migration reviewed carefully.
- The inspection engine assumes a control plan and a machine/site; incoming inspection will need a deliberate extension, not a bypass.
- Everything the spec calls "scheduled" (expiry, re-evaluation, due dates) is computed on read until a worker exists (D3).

## 8. Proposed first step
SQ1 (register and profile) is self-contained, needs no decision except D4/D6, and lays the status/history/permissions groundwork everything else uses.
