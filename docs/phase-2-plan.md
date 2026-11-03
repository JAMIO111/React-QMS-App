# Phase 2 — First complete QMS workflow: plan

**Status:** agreed (decisions §8) · **Date:** 2026-11-03 · **Branch:** `Dev`
**Brief:** `docs/design-brief.md` §6.1–6.4 (domain model), §8 (events), §10 (API), §11 (security),
§12 Phase 2, §13 (backlog), §14 (definition of done) · **Builds on:** `docs/phase-1-exit-report.md`

## 1. Scope

**Exit criterion (brief §12):** a user can complete an end-to-end
*inspection failure → NCR → investigation → corrective action → effectiveness verification*
workflow with traceability and audit history.

In scope:

1. **Gate items from the Phase 1 exit report** — invited-user password flow ("set your password",
   "forgot password"), MFA (TOTP) with an organisation-level "require MFA" option.
2. **Parts and part revisions** (+ customers and suppliers as canonical master data, because NCRs
   reference them).
3. **Inspection plans and characteristics** with explicit units.
4. **Manual inspection result entry**, pass/fail decided server-side; a failure can raise an NCR.
5. **NCR register and detail** on the new model, through the API (replacing the legacy
   `NCM`-based screens).
6. **Containment, investigation / root cause, disposition** (with approval).
7. **CAPA**: corrective actions, links to one or more NCRs, effectiveness verification, closure.
8. **Evidence and history**: attachments on any record, comments, a history tab from `audit.events`.

Out of scope (later phases, brief §12/§15): production orders, lots/serials and equipment as
master data (Phase 3 — Phase 2 keeps them as free-text references), document control, audits,
configurable/versioned workflow designer, SPC, integrations and background workers (Phase 5),
custom forms, exports beyond CSV.

## 2. Data model

Canonical snake_case names; every table tenant-owned (`organisation_id NOT NULL`, composite
`(id, organisation_id)` keys for references), RLS + `audit_changes` trigger, written only through
the API (`DatabaseService.asUser`). Guardrails and the tenancy sweep will fail until each new table
is covered — intended.

### 2.1 Master data

| Table | Key columns | Notes |
|---|---|---|
| `customers`, `suppliers` | code, name, display_name, active | Replace legacy `"Customers"` / `"Suppliers"` (data migrated) |
| `parts` | part_number (unique per org), name, description, customer_id?, active | Replaces legacy `"Part"` |
| `part_revisions` | part_id, revision (e.g. `A`, `B`), drawing_ref, status `draft → released → obsolete`, released_at/by | Inspection plans and NCRs point at a **revision** |
| `units` | code (`mm`, `in`, `µm`, `deg`, `N·m`, `kg`, `%`, `count`…), name, quantity_kind | Global read-only catalogue. No conversions in Phase 2: a result is entered in its characteristic's unit |

### 2.2 Inspection

| Table | Key columns | Notes |
|---|---|---|
| `inspection_plans` | part_revision_id, name, version, status `draft → released → superseded` | Only a **released** plan can be used; editing a released plan creates a new version |
| `inspection_characteristics` | plan_id, seq, name, kind `variable`/`attribute`, nominal, lower_limit, upper_limit (`NUMERIC`), unit_id, method, criticality `critical/major/minor` | Limits stored as absolute values (UI accepts nominal ± tolerance) |
| `inspection_records` | plan_id, part_revision_id, site_id, work_order, lot, quantity_inspected, status `in_progress → passed/failed`, inspected_by, inspected_at | One inspection event |
| `inspection_results` | record_id, characteristic_id, measured_value `NUMERIC` / attribute_ok, unit_id (copied), outcome `pass/fail` (computed in the DB), device, note | Immutable once the record is submitted; corrections add a superseding result with a reason |

### 2.3 Non-conformance (NCR)

| Table | Key columns | Notes |
|---|---|---|
| `nonconformances` | reference (`<prefix>-000123`, per-org sequence), source `internal/customer/supplier/inspection`, severity `critical/major/minor`, stage (§3), title, description, requirement, actual, site_id, part_revision_id, customer_id / supplier_id, work_order, lot, serial, quantity_affected, detected_at, detected_by, owner_id, inspection_record_id? | Few fields required at creation; more required per stage |
| `ncr_containments` | ncr_id, action, owner_id, due_date, status `open/done`, done_at, quantity_contained | Many per NCR |
| `ncr_investigations` | ncr_id (one), method (`5-why`, `fishbone`, `8D`, `other`), root_cause_category, root_cause, contributing_factors | 8D becomes an investigation method, not a separate record type |
| `ncr_dispositions` | ncr_id, decision `rework/repair/scrap/use_as_is/return_to_supplier/concession`, quantity, instructions, approved_by, approved_at | Quantities must not exceed quantity affected |
| `ncr_costs` | ncr_id, cost_type, amount, currency | Carries over the legacy cost tracking (cost of poor quality) |
| `ncr_comments` | ncr_id, body, author | Append-only |

### 2.4 CAPA

| Table | Key columns | Notes |
|---|---|---|
| `capas` | reference (`CAPA-000045`), title, problem_statement, type `corrective/preventive`, stage, owner_id, due_date | Its own domain (brief §6.3) |
| `capa_links` | capa_id, ncr_id | Many-to-many: one CAPA can address several NCRs |
| `capa_actions` | capa_id, description, owner_id, due_date, status `open/done/cancelled`, done_at, evidence note | |
| `capa_verifications` | capa_id, method, effective (bool), notes, verified_by, verified_at | Effectiveness check; a failed check reopens actions |

### 2.5 Evidence and history

- `attachments`: entity_type + entity_id (any record above), file name, size, content type,
  storage path `qms-files/<organisation_id>/<entity_type>/<entity_id>/<uuid>` in a private bucket;
  upload/download through short-lived signed URLs issued by the API after a permission check.
- History: the existing `audit.events` (already captures actor, source, reason, correlation id);
  the API exposes a per-record timeline.

### 2.6 Domain events (decision Q3)

`outbox_events` (organisation_id, event_type, entity_type, entity_id, payload jsonb, created_at,
processed_at) written by the database in the **same transaction** as the change, for:
`part.revision.released`, `inspection.plan.released`, `inspection.record.submitted`,
`inspection.result.failed`, `ncr.created`, `ncr.stage_changed`, `ncr.closed`, `capa.created`,
`capa.verified`, `capa.closed`. Event types are versioned in the payload (`"v": 1`). Append-only
for the API role; nothing processes them yet. A worker (Phase 5) will publish and mark them
processed idempotently. Readable by `audit.read` holders for diagnosis.

### 2.7 Legacy tables

`"NCM"`, `"8D"`, `"Costs"`, `"NC Files"`, `"Part"`, `"Customers"`, `"Suppliers"`, `"Status"`,
`"Failure Mode"`, `"Sub-Failure Mode"`, `"Process"` and the `v_ncm_*` views: data moved to the new
tables (see decision Q1), legacy screens switched to the API, then the legacy tables dropped in a
later, separate migration once nothing reads them. Failure modes and processes become
organisation-managed classification lists (`ncr_classifications`) used by NCRs and root causes.

## 3. Workflow

NCR stages, enforced by the database (transition function + trigger) and checked again by the API:

```text
draft → open → contained → investigating → dispositioned → awaiting_closure → closed
                                                           ↘ cancelled (from any stage before closed, with reason)
```

| Transition | Requires | Permission |
|---|---|---|
| draft → open | title, source, severity, part revision or description of item, quantity affected | `ncr.create` |
| open → contained | ≥1 containment action, all done (or a recorded "no containment needed" reason) | `ncr.update` |
| contained → investigating | owner assigned | `ncr.update` |
| investigating → dispositioned | root cause recorded; dispositions covering the affected quantity, approved | `ncr.update` + `ncr.disposition.approve` |
| dispositioned → awaiting_closure | linked CAPA, or "no CAPA needed" with reason | `ncr.update` |
| awaiting_closure → closed | linked CAPA(s) verified effective | `ncr.close` |

CAPA stages: `open → actions_in_progress → awaiting_verification → verified_effective → closed`
(a failed verification returns to `actions_in_progress`). Closing an NCR with an open CAPA is
refused.

Organisation settings (Settings → Organisation): when an inspection fails → *prompt to raise an NCR
(pre-filled)* or *raise one automatically*; whether approver must differ from the raiser.

Stage labels/colours: fixed stage **keys** (so reports and rules stay reliable) with
organisation-editable labels and colours, replacing the free-form legacy `Status` table.

## 4. Security and permissions

New permission codes (seeded, assigned to the system role templates and copied to existing
organisations): `parts.read`, `parts.manage`, `inspection.read`, `inspection.record`,
`inspection_plans.manage`, `ncr.disposition.approve`, `ncr.close`, `capa.read`, `capa.manage`,
`capa.verify`, `attachments.read`, `attachments.manage`. Existing `ncr.*`, `master_data.*` and
`lookups.manage` are reused.

Every route `@OrganisationScoped`; record-level site scoping uses the site-scoped role assignments
from Phase 1.5 (a user scoped to one site sees and acts on that site's records only). Cross-tenant
sweeps (SQL and API) extended to every new table and route automatically.

Auth gate items: Supabase invite → "set your password" page; "forgot password" with the Supabase
reset flow; MFA enrolment (TOTP, recovery via a second factor), `organisation_settings.require_mfa`
enforced by the API (AAL2 claim check) and the frontend.

## 5. API and frontend

API modules: `parts`, `customers`, `suppliers`, `inspection` (plans, records, results), `ncr`,
`capa`, `attachments`, `history`. Lists keyset-paginated, sortable and filterable server-side;
state changes are explicit commands (`POST /ncrs/{id}/transitions`) rather than free status edits;
idempotency keys on creates.

Frontend (all through `apiFetch`, reusing `Table`, `ColumnVisibilityMenu`, theme tokens and Lucide
icons): Parts (list, detail with revisions), Inspection plans (builder with characteristics),
Inspection entry (fast keyboard entry, live pass/fail), NCR register (the existing table on the new
API) and NCR detail with stage tabs (Details · Containment · Investigation · Disposition · CAPA ·
Evidence · History), CAPA register and detail. Dashboard KPIs re-pointed at the new tables.

## 6. Delivery slices

Each slice is a complete, tested vertical slice (migration + `db:check` + API + e2e + UI + docs),
applied to the live project before the next starts.

| Slice | Content |
|---|---|
| **2.0** | Auth gate: set-password and forgot-password flows, MFA enrolment and per-org enforcement |
| **2.1** | Units catalogue, customers, suppliers, parts, part revisions (+ legacy master data migrated) |
| **2.2** | Inspection plans and characteristics (versioning, release) |
| **2.3** | Inspection records and manual results; failure → NCR prompt/auto |
| **2.4** | NCR core: register, detail, stage machine, classifications, comments, attachments, history; legacy NCRs migrated; legacy screens switched over |
| **2.5** | Containment, investigation / root cause, dispositions with approval, costs |
| **2.6** | CAPA: links, actions, effectiveness verification, NCR closure rules |
| **2.7** | Exit check: end-to-end scenario (API e2e + browser), guardrails, exit report |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Switching the NC screens breaks day-to-day use | Data migrated and rehearsed on a copy first; old tables kept until the new screens are verified |
| Workflow rules too rigid for real users | Stage requirements kept minimal and listed in one place; configurable workflows planned for Phase 4 |
| Measurement correctness (units, precision) | `NUMERIC` everywhere, units explicit, pass/fail computed in the database, boundary tests (on-limit values pass) |
| Attachments leak across tenants | Organisation id in the storage path, storage RLS, signed URLs from the API only, sweep test |
| Vercel serverless limits (file uploads, cold starts) | Uploads go browser → Supabase Storage directly with a signed upload URL; API only signs |

## 8. Decisions needed

### Agreed (2026-11-03)

- **Q1** Migrate the legacy test data (NCRs, parts, customers, suppliers, classifications) into the
  new tables; keep the old tables until the new screens are verified, then drop them.
- **Q2** Fixed NCR/CAPA stages with organisation-editable labels and colours; workflow designer later.
- **Q3** Record domain events in `outbox_events` from the start (§2.6); no processor yet.
- **Q4** Start with slice 2.0 (auth gate), then 2.1 onwards.

### Questions as asked

1. **Q1 Legacy NC data** — migrate the 20 test NCRs (and 6 parts, 10 customers, 2 suppliers) into
   the new tables, or start clean?
2. **Q2 Workflow configurability** — fixed stages with editable labels (recommended for Phase 2), or
   organisation-defined statuses now?
3. **Q3 Domain events / outbox** — add the `outbox_events` table and write events in the same
   transaction now (no processor until a worker host exists), or defer to Phase 5?
4. **Q4 Order** — start with slice 2.0 (auth gate) as recommended, or go straight to the QMS
   workflow (2.1) and do auth before real users?

## 9. Slice 2.0 — auth gate — done (2026-11-03)

**Password flows**
- `/forgot-password` sends Supabase's reset email (`redirectTo …/set-password?mode=reset`) and
  answers the same way whether or not the address has an account; rate limits are explained.
- `/set-password` is the landing page for invitation (`?mode=invite`) and reset links: explains
  expired/used links (captured from the URL before Supabase clears it,
  `initialAuthLinkError`), enforces app password rules (≥ 10 characters, letters and numbers, not
  the email name), sends two-factor users through `/mfa` first if Supabase asks for AAL2.
- Sign-in "Forgot your password?" now links there. `INVITE_REDIRECT_URL` should be
  `<frontend>/set-password?mode=invite`.
- Also fixed: the session (including the access token) was logged to the browser console on every
  auth event; the sign-in hero image path was wrong (`/public/hero.jpg` → `/Hero.jpg`).

**Two-factor authentication (TOTP)**
- Settings → Account: set up (QR code or manual key, confirm a code) and turn off.
- Sign-in: users with an authenticator app are asked for the code (`/mfa`) before any page;
  `?next=` only accepts same-site paths.
- Settings → Organisation: "Require two-factor authentication" (owners/admins). It cannot be
  switched on from a session that has not passed two-factor (UI + database, SQLSTATE `QM002` →
  API 409 `mfa_setup_required`), so an owner cannot lock themselves out.
- Enforcement is in the database (`20251104110000_mfa_requirement.sql`): `app.is_member`,
  `app.has_permission`, `app.member_organisation_ids`, `app.my_permissions` and
  `app.shares_organisation` add `app.mfa_satisfied(org)` (organisation does not require MFA, or the
  JWT `aal` claim is `aal2`). This covers the API, the legacy screens that still read tables
  directly, and storage. `app.mfa_blocked_organisations()` lists the caller's organisations that
  need MFA; `/me` returns `mfa: { level, requiredBy }` and the API answers `403 mfa_required`
  (not 404) for those, so the app sends the user to set it up.

**Tests:** SQL `mfa_requirement.test.sql` (aal1/aal2 access, lock-out guard, other organisations
unaffected, own membership visible, audited); API e2e `mfa.e2e-spec.ts` (8); frontend: password
flows (10), MFA gate/page (9), account card (3), organisation switch (4). Totals: 12 SQL files,
API 37 unit / 76 e2e, frontend 90. Browser: forgot-password, expired invitation, `/mfa` redirect
when signed out, hero image — no console errors.

**Live:** migration applied and recorded; checked on the real organisation inside a rolled-back
transaction (aal1 unchanged today; enabling from aal1 refused; once required, aal1 sees nothing
and is told why); guardrails 0 violations; no organisation requires MFA yet.

**Not verifiable here:** the actual emails (invite/reset) and a real authenticator app — please
try them on the Dev deployment. Supabase settings to check: Authentication → URL Configuration →
Redirect URLs include the frontend (`…/**`, and `http://localhost:5173/**` for local work);
Authentication → Multi-Factor → TOTP enabled (Supabase's default).
