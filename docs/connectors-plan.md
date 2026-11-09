# Connectors and integrations (brief Phase 5) — plan

**Status: decisions D1–D10 agreed (D4 refined as in §3 and §5; D5 and D7 amended and D9–D10 added after IN3, see §6.7–§6.9). IN0–IN3 done; IN4 next.**

Source: `docs/design-brief.md` §7 (integration platform), §8 (events), §12 Phase 5, §13 (integration backlog), §14 (definition of done for integrations), §15 (non-goals).
This is the **planning document**. Nothing here is built. Each slice is agreed before it starts (CLAUDE.md, brief §14).

Phase 5 exit criterion (brief): *a customer can safely import a supported external dataset, map it to canonical records, preview it and synchronise without duplicates.*

## 1. What exists today (checked in the repo and on the live project)

| Needed by Phase 5 | What Fortress has | Verdict |
|---|---|---|
| Canonical models to import into | `parts` + `part_revisions`, `customers`, `suppliers`, `production_orders` (+ operations, lots, serials), `purchase_orders` + lines, `goods_receipts` + lines, `lots`, `nonconformances`, inspection records | **Reuse.** These are the canonical records; connectors must never write to them directly |
| External-id reservation | `production_orders.external_system` / `external_id` (unique per org, people cannot set them; migration `20251210100000`). **Not** on purchase orders, receipts, parts, suppliers, customers | Extend, and decide one mechanism (decision D4) |
| Event outbox | `outbox_events` (written by `app.emit_event` in SECURITY DEFINER triggers); **nothing consumes it** | Reuse for outbound later (Phase 6); Phase 5 only reads/imports |
| Background work | **No worker.** Overdue/expiry is computed on read; the only schedules are Vercel crons on the production deployment (`api/vercel.json`), guarded by `CRON_SECRET`; system work runs as the API login (`DatabaseService.asApi()`, functions executable only by `qms_api`) | Constrains the sync engine (decision D2) |
| Secrets | **No tenant secret store.** Stripe keys are environment variables (one set per deployment, not per customer). **`supabase_vault` 0.3.1 is installed** on the live project | Use Vault (decision D3) |
| Audit trail | `audit.record_change` takes the actor from `auth.uid()` and the source from the transaction setting `app.source` (else `client`, or `system` with no user) | A system import has no user: needs an integration actor (§6.6) |
| Upload + staging patterns | Private storage buckets with `<org>/<area>/<id>/<uuid>-<name>`, uploads gated by a function, functions-only writes, never deleted | Reuse for the import files |
| Tenancy guardrails | RLS on every table, composite `(id, organisation_id)` FKs, both sweeps, `QMxxx → 409` error codes | Every new table follows this |
| UI conventions | `TableWrapper`, filter drawer, `Callout`, `DropdownMenu`, `ComboField`, `SlidingToggle`, optimistic hooks | Reuse; no second visual language |
| Master data overview | "Integrations and change events" card says no connector tables exist | Becomes the first consumer of connection health |

## 2. Principles (from the brief, restated for this module)

1. **The pipeline is the product:** source → adapter → **staging** → mapping → validation → canonical write → event. Validate before writing business records.
2. **Connectors never bypass the QMS.** They call the same SECURITY DEFINER functions the app uses, or purpose-written *import* variants that enforce the same rules; they never write tables directly and never release, approve or close anything.
3. **Idempotent by construction.** The external record map (connection, entity type, external id → internal id) plus a content hash means a repeated import creates nothing new.
4. **Failed records stay visible and retryable.** A bad row never blocks the good ones and is never silently dropped.
5. **Provenance is kept:** the original payload (or a reference), the mapping version, the run, who started it.
6. **Ownership is explicit per field.** A connector never overwrites a field the QMS owns.
7. **Read-only by default.** No write-back in Phase 5.
8. **Generic first:** CSV/XLSX and a generic REST connector before any bespoke provider (brief §15: no SAP/Dynamics before the framework is proven).

## 3. Decisions needed

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Which entities in Phase 5, in what order** | (a) the brief's minimum: parts and production orders; (b) also suppliers, customers, purchase orders and receipts; (c) everything including inspection results | **(b), in this order:** parts (+ suppliers, customers as lookups) → production orders → purchase orders and lines → goods receipts. Receipts matter because supplier performance (on-time, in full, PPM) depends on them and customers already hold that data in ERP inventory transactions. **Inspection results (CMM) stay in Phase 6**, as the brief says |
| **D2** | **Where sync work runs** (no worker today; Vercel functions are short-lived) | (a) a DB-backed job queue (`integration_sync_jobs`, `FOR UPDATE SKIP LOCKED`) drained in **time-boxed batches** by an API call ("Run now", driven by the UI) and by a cron route for schedules; (b) add Redis/BullMQ and a separate worker host now | **(a) now, shaped so (b) is a swap.** The runner is one service function (`runBatch(jobId)`) callable from the API, a cron, or a later worker. Schedules only fire where crons run (production deployment, currently daily); finer schedules need a worker, which I'd add when a customer needs sub-daily sync |
| **D3** | **Credential storage** | (a) Supabase Vault: tenant table holds only a secret id; read/decrypt through functions executable by `qms_api` only; (b) application-level encryption with a key in an environment variable; (c) environment variables per customer | **(a).** Already installed, encrypted at rest, keeps secrets out of tenant tables, logs and client bundles. Show secrets never after entry; rotate and revoke are explicit actions |
| **D4** | **External-id mechanism** (production orders already carry `external_system` / `external_id`) | (a) one central map for everything; (b) the columns on every canonical table; (c) **hybrid** | **(c), agreed.** **Master data** (suppliers, customers, parts, production orders, purchase orders): the central `integration_external_records` map, with a **narrow primary key `(organisation_id, connection_id, entity_type, external_id)`** (no surrogate id; partition-ready by organisation) and **no per-row "last synced" column** (a row is written only on create or when the content hash changes; "last synced" is tracked per run). **High-volume event records** (receipt lines from inventory transactions): the source transaction id is stored **as a column on the record itself** (`source_connection_id`, `external_id`, unique per connection), so idempotency comes from that unique index and there is **no second row per record**. Imports look ids up one batch at a time (`= ANY`) and write with one upsert per batch. The existing production-order columns stay and are filled by the import. Staged payloads are purged by age; map rows are kept (idempotency needs them) |
| **D5** | **Match-only or upsert, per entity** | A connection can (a) only update records it already mapped, (b) create new ones too, (c) only *match* existing QMS records by a chosen key | **Per entity, a setting with the safest default:** suppliers, customers and parts default to *create and update*; receipts and purchase orders require their supplier and part to **match an existing record** (a row naming an unknown supplier is rejected with a clear error, not auto-created). Each rejected row says what to create or map |
| **D6** | **What an import may and may not do to quality-controlled records** | e.g. imported part revisions released automatically? | **No release, approval or closing by import, ever.** Part revisions arrive as **drafts**; production orders arrive in their source status mapped to ours but cannot skip our rules; receipts never put lots on hold retroactively (historical mode) and never create inspection holds for old deliveries |
| **D7** | **Entitlement and permissions** | module `integrations` gated by package or open to all | New permissions `integrations.read / .manage / .run / .approve` (owner, admin, quality manager manage and run; **activating a connection needs a second person with `.approve` — preparer ≠ approver**, as for supplier approvals and inspection rules). Subscription: a new feature `integrations`, mapped to a package you choose (commercial call, not mine) |
| **D8** | **File size and volume limits for Phase 5** | — | 25 MB per file (as other uploads), 100,000 rows per run; larger needs the Phase 6 agent or chunked REST. Say if a real customer needs more |

| **D9** | **Import settings per connection and kind of record** (agreed after IN3) | — | One setting decides what an import may do: **add new only**, **add new and update existing**, or **update existing only**; plus **match existing Fortress records by code**, **field ownership**, a **schedule** and what happens when a record **disappears** from the source. Non-conformances are always *add new only*. Replaces D5's fixed per-entity defaults with a setting whose default is the safest choice for the kind of record. §6.7 |
| **D10** | **References between imported records** (agreed after IN3) | — | A field that links to another record (site, department, part, machine, gauge type, supplier, customer, employee, category, unit) matches **either by the id the source gave that record in an earlier import** (looked up in the map, across every connection with the same `external_system` code) **or by the Fortress code**. A row whose link cannot be resolved is rejected with the reason, in the preview as well as the real import; nothing is guessed or created to satisfy it. §6.8 |

**Change after IN2 (agreed with the product owner):** integrations are for **Controller seat holders only** (every `integrations.*` permission also needs an active Controller seat), and an organisation-wide **Owner or Admin may activate a connection they prepared themselves**; everyone else still needs a different approver (D7 amended).

**Change after IN3 (agreed with the product owner):** a **file connection** (`csv`) has no test / ready / activate / pause / resume lifecycle: it can be used once created, and **whoever imports a file approves it themselves** (no second person). Only Controller seat holders can do any of it (every `integrations.*` permission already needs a Controller seat). API connections keep the lifecycle and the activation approval of D7, because they run unattended (D7 amended again; §6.9).

## 4. Architecture

```
                 ┌────────────── QMS (modular monolith) ──────────────┐
 CSV / XLSX  ──► │ adapter (csv)  ─┐                                   │
 REST API    ──► │ adapter (rest) ─┼─► STAGING  ─► mapping ─► validation │
 (Phase 6:       │                 │  (inbox)      (versioned)  (rules)  │
  agent, SQL)    │                 │                         │          │
                 │                 │                         ▼          │
                 │                 │            canonical writers        │
                 │                 │      (SECURITY DEFINER import fns,  │
                 │                 │       same business rules)          │
                 │                 │                         │          │
                 │   sync engine: runs, batches, cursors,    ▼          │
                 │   retry/backoff, dry-run, monitoring    domain tables│
                 └────────────────────────────────────────────────────┘
```

Code layout (NestJS, `api/src/integrations/`, mirroring the brief):
- `core/`: `connector.interface.ts` (the adapter contract with capability discovery), `connector.registry.ts`, `sync.engine.ts`, `mapping.engine.ts` (a **closed transform set**, no user code), `validation.engine.ts`.
- `providers/csv/`, `providers/rest-api/` (Phase 5). `sql-server/`, `sap/`, `microsoft-dynamics/`, `pc-dmis/` are *not* created.
- `entities/`: one module per canonical entity (parts, production orders, purchase orders, receipts…) holding its field catalogue, validation and the call into its import function.
- Frontend `src/components/integrations/`, hooks `useIntegrations.js`.

The adapter contract (brief §7.3, trimmed to what Phase 5 needs):
`getMetadata()` (provider, auth types, capabilities), `testConnection()`, `discoverEntities()`, `fetchRecords(entity, cursor)` → `{ records, nextCursor, done }`. `subscribeToEvents` and `pushRecord` are declared optional and **not implemented** (webhooks and write-back are Phase 6).

## 5. Data model (all tenant tables: RLS by `integrations.read`, no table writes, functions only, audit trigger, never deleted)

| Table | Purpose |
|---|---|
| `integration_providers` | Global catalogue (csv, rest_api): name, capabilities, auth types, status. Platform-owned, reviewed in the guardrails like `units` |
| `integration_connections` | One per customer source: provider, name, status (`draft` → `ready` → `active` → `paused` → `retired`), config (non-secret), `external_system` code, who created/approved/activated |
| `integration_credentials` | Connection id + **Vault secret id** + kind (api key, bearer, basic, oauth client), rotated-at, revoked-at. No secret value, ever |
| `integration_entities` | What a connection brings: entity type (`part`, `production_order`, …), source object/endpoint, key field(s), cursor field, match/upsert policy (D5) |
| `integration_field_mappings` | **Versioned** per connection + entity: source field → canonical field, transform, required, default, **ownership** (`source_wins` / `qms_wins` / `manual_review`). A saved mapping version is immutable; runs record the version used |
| `integration_sync_jobs` | **Merged into `integration_sync_runs` in IN2** (a run is queued, leased, resumed and finished, with its attempts and next attempt on it): one table instead of two, nothing lost |
| `integration_sync_runs` | One execution: counts (fetched, staged, valid, rejected, created, updated, skipped, unchanged), mapping version, started/finished, who, result, error summary |
| `integration_sync_cursors` | Per connection + entity: the last good cursor / watermark, advanced only after a batch is applied |
| `integration_external_records` | **The map for master data:** primary key (organisation, connection, entity type, external id) → internal id, content hash, last run id. Written only on create or when the hash changes (no per-sync timestamp churn). Receipt lines do **not** use this table: they carry `source_connection_id` + `external_id` columns (D4) |
| `integration_inbox` | **Staging:** one row per source record per run: raw payload (jsonb), source row number, external id, content hash, status (`staged` → `validated` / `rejected` / `unchanged` → `applied` / `failed` / `conflict`), errors (field-level, actionable), attempt count. Retained for replay; payload retention policy in §8 |
| `integration_errors` | Run-level failures (auth, rate limit, malformed file, mapping error) separate from row errors. Built in IN2 as `integration_run_errors` (append-only) |
| `integration_outbox`, `integration_webhook_*` | **Created empty-shell or skipped** in Phase 5 (Phase 6). I would not create them until needed |

Import files: private bucket `integration-files`, path `<org>/integration/<connection>/<uuid>-<name>`, upload only via a function, readable with `integrations.read`.

**As built in IN2:** the inbox, runs and run errors carry no audit trigger (they are themselves the record of the work and change on every batch); the map and the cursors are audited, and integration work records the person who started the run as the audit actor (`app.source = 'integration'`, `app.initiating_user`). Staged payloads are cleared after 90 days by `app.system_purge_integration_payloads` (failed rows keep theirs); the cron route for it arrives with schedules (IN8).

## 6. How it behaves

### 6.1 Setting up a connection (the journey in brief §9)
Select provider → configure and **test** → discover entities (REST: from a configured endpoint list; CSV: from the file's headers) → choose entity → **map fields** (suggested from header names; required canonical fields flagged) → **preview** → a second person **approves activation** → schedule.

### 6.2 Preview / dry run
Fetch (or read the file) → stage → map → validate → compute *would create / update / skip / reject* with a sample of before-and-after, **without writing canonical records** and without advancing the cursor. A connection cannot be activated without a preview run that has no blocking errors. The preview is stored (so the approver sees exactly what was previewed).

### 6.3 A real run
Batches (default 500 rows) so one request is short. Each batch: stage → map → validate → for each valid row call the entity's import function, in its own savepoint so one bad row never rolls back the others → update the external record map → advance the cursor **only after the batch commits**. A run is resumable: if a function times out, the next call continues from the last committed batch. Transient errors retry with exponential backoff (rate limits honour `Retry-After`); permanent errors mark the row or run failed with a message a person can act on.

### 6.4 Idempotency
Identity = (organisation, connection, entity type, external id) for master data, (connection, external id) on the record itself for receipt lines. Content hash unchanged → row `unchanged`, **nothing written, not even a timestamp** (one lookup query and one upsert per batch, never per row). Same file uploaded twice, or a REST page fetched twice, creates **no duplicates** (this is an automated test per entity).

### 6.5 Ownership and conflicts (Phase 5 scope: simple and explicit)
Per mapped field: `source_wins` (the connector updates it; the QMS shows it read-only where it makes sense), `qms_wins` (the connector sets it on create and never again), or `manual_review` (a differing value is parked as `conflict` for a person to accept or reject). Fields not mapped are never touched. Phase 6 adds field-level conflict resolution UI; Phase 5 ships the policy and the review queue.

### 6.6 Audit and provenance
Import functions run as the API login with no user, so the audit actor would be empty. They set `app.source = 'integration'`, the correlation id to the **run id**, and an **initiating user** (who started or approved the run; a schedule uses the user who activated it), so every audit event says *imported by connection X, run Y, started by Z*. Canonical rows show **"Imported from X"** with a link to the run and the original staged payload.

### 6.7 Import settings (D9)

Set per connection **and** kind of record (on the mapping page), frozen onto every run beside the mapping version, so a run always says why a record was or was not changed.

| Setting | Choices | Default |
|---|---|---|
| **What an import may do** | *Add new only* (records already imported are never touched again: the historical-import setting; re-uploading a later export adds only the new rows) · *Add new and update existing* (the source keeps feeding changes: the "kept in sync" setting) · *Update existing only* (enrich records already there, create nothing) | *Add new only* |
| **Match existing Fortress records** | On: a row whose code matches a record made by hand is linked to it (and treated as an update) instead of being created again. Off: only records this source system created are updated | Off |
| **Field ownership** (per mapped field, stored on the mapping since IN3) | *Source wins* (an update overwrites it) · *Fortress wins* (set on create, then only people change it) · *Review* (a differing value is parked for a person to accept or reject) | *Source wins* |
| **Schedule** | *Manual* · *Daily* (cron on the production deployment; sub-daily needs a worker, D2). Only a connection Fortress can fetch from (REST, or a CSV at an address) can be scheduled: **an uploaded file is always manual** | *Manual* |
| **When a record disappears from the source** | Nothing · list it on the run · make it inactive (kinds that have Active). **Nothing is ever deleted** | Nothing |

Fixed rules: **non-conformances are always *add new only*** (once in Fortress an NC's investigation, containment, dispositions and stage are managed there; the catalogue has no workflow fields anyway); imported NCs arrive as drafts; gauge calibration dates and status are never imported; part revisions arrive as drafts (D6); suppliers arrive pending approval.

The three situations this covers:

| Situation | What an import may do | Schedule | Ownership |
|---|---|---|---|
| Historical import, then managed in Fortress | Add new only | Manual | not used |
| Kept in sync (e.g. parts or employees from ERP / HR) | Add new and update existing | Daily | mostly *source wins*; Fortress-only fields *Fortress wins* |
| Imported once, topped up now and then | Add new only (or update existing only) | Manual, upload again | not used |

### 6.8 References between imported records (D10)

Fortress keeps its own ids. The map (`integration_external_records`) records *"machine 17 in Sage became Fortress machine CNC-01"*. When an NC row says its causal machine is `17`, the importer looks `17` up as a machine **from the same source system** and writes Fortress's own id onto the NC (a real foreign key, so renaming the machine never breaks it); the source's id stays only in the map, which is also what makes re-importing the same or a corrected file update instead of duplicate.

Each reference field in a mapping says how it matches: **by the source's id from an earlier import** (looked up across every connection with the same `external_system` code, so machines imported through one file connection resolve when NCs arrive through another) or **by the Fortress code** (for records that existed in Fortress before). Import the referenced records first (sites and departments exist in Fortress; then suppliers, customers, machines, employees, gauge types, parts; then gauges and NCs). An unresolved reference rejects the row with the reason, **in the preview too**; a retry after the missing record is imported picks it up.

### 6.9 File connections (D7 amended after IN3)

A file connection is created ready to use: the page shows **Files**, **Mapping** (with the import settings) and **Imports**; no test, ready, activate, pause or resume (retire stays, in a "…" menu, to tidy up). Uploading, mapping and previewing need `integrations.run` / `.manage`; a **real import is approved by the person who starts it**. All of it needs a Controller seat. API connections keep the full lifecycle and the second-person activation (owner/admin self-activation as amended after IN2).

## 7. Entity catalogue (Phase 5)

| Entity | Canonical target | Match key | Notes |
|---|---|---|---|
| Customers, suppliers | `customers`, `suppliers` | code, or external id | Create/update master fields only. A new supplier arrives **pending approval** (the existing rule); status and risk are never imported |
| Parts | `parts` | part number | Revisions import as **drafts** (D6); characteristic specs are not imported in Phase 5 |
| Machines | `machines` | code | Site by site code. Added after IN3 (Nov 2026) at the user's request, as are the four rows below |
| Employees | `"Employees"` | employee number | Site and department by code (the department fills the site). Never deleted (deactivated); linking to a sign-in stays a Controller-seat holder's step, never imported |
| Gauge types | `gauge_types` | name | Interval only; characteristics are set up in Fortress |
| Gauges | `gauges` | asset number | Gauge type by name, site/department/supplier by code, unit by code. **Calibration dates and status are never imported**: they follow the calibrations recorded in Fortress |
| Non-conformances | `nonconformances` | the old system's NC number | **Historical NCs:** arrive as **drafts** with a Fortress reference; source required (one of the eleven), category / part / customer / supplier / machines / responsible employee by code. Opening, moving stages and closing stay a person's steps (the brief's "a connector never closes an NC") |
| Production orders | `production_orders`, optionally operations | order number | Fills the reserved `external_system` / `external_id`; status mapped; cannot complete with pending operations (existing rule) |
| Purchase orders + lines | `purchase_orders`, `purchase_order_lines` | PO number + line | `requested_on` is set on create and **never changed by sync** (it is the original date); `agreed_on` follows the source |
| Goods receipts | `goods_receipts`, `goods_receipt_lines`, lots | the source transaction id | **Historical mode** (§8): accepts closed orders, creates no inspection holds, sets the real dates. Supports the inventory-transaction shape (filter by transaction codes, group by document, lot from the lot field) and the PO-line-total shape (delta events). Returns/rejections become dispositions, never negative lines |
| Reconciliation | none | — | PO-line received quantity and last date compared with the sum of imported receipts; mismatches reported as data-quality notes |

Each entity module declares: canonical fields (type, required, allowed values), transforms allowed, match policy, the import function, and its reconciliation checks.

## 8. Security (non-negotiable list)

- **Tenant isolation in background work.** `asApi()` bypasses RLS, so every system function takes the organisation id and **re-verifies that the connection, run and inbox rows belong to it**; tests prove an org-A connection id used with org B does nothing. Runs, cron and "Run now" all go through the same checks.
- **SSRF defence for the REST connector** (this is the biggest new attack surface in a multi-tenant SaaS): https only; resolve DNS and **reject private, loopback, link-local and cloud-metadata ranges** and re-check after redirects (or disable redirects); fixed allowed ports; connect and read timeouts; response size and record caps; no user-supplied headers that override `Host`; a per-organisation allow-list option.
- **Secrets:** Vault ids only in tables; functions that read secrets are executable by `qms_api` only; secrets never appear in API responses, logs, error messages, the staged payload or the client bundle (tests assert it).
- **No arbitrary execution:** the mapping engine is a closed set (trim, case, date parse with format, number parse with locale, unit conversion from a table, value map, constant, concat, lookup by a key). No expressions, no SQL, no scripts.
- **Files:** size and type checks, CSV formula-injection-safe on export (the existing `reportCsv` rule), no path from user input.
- **Payload retention:** staged payloads can contain personal data; keep for a configurable period (default 90 days) then null the payload and keep counts and errors. Decision before build if you have a retention rule.
- **Rate limits** and per-organisation concurrency (one active run per connection and entity).

## 9. UI (Settings → Integrations, plus links where records are shown)

1. **Catalogue** of providers (csv, rest_api).
2. **Connections** list with health (last success, frequency, records processed, rejected) and a status pill.
3. **Setup** wizard as in §6.1.
4. **Mapping** screen: source column ↔ canonical field, transform picker, required markers, ownership per field, saved as a new version with a reason.
5. **Preview** results: counts, sample changes, errors grouped by cause.
6. **Runs** history and run detail; **Rejected records** with the error, the payload, an **edit-and-retry** or **ignore** action.
7. Records show **"Imported from … (run, original row)"**.
8. The master-data overview's integration card shows real connection state instead of "none".

## 10. Slices

| Slice | Content | Exit |
|---|---|---|
| **IN0** | This plan agreed; decisions D1–D8 settled; sample data from one real customer (e.g. an inventory-transactions export) | Plan signed off |
| **IN1** ✅ | Providers catalogue, connections, credentials (Vault), permissions + feature, state machine, audit; API + settings shell; guardrails and both sweeps | A connection can be created, credentials stored and revoked, nothing leaks |
| **IN2** ✅ | External records map, staging inbox, sync jobs/runs/cursors, the batch runner, idempotency core, run monitoring API | A fake source imported twice stages and applies once; a failed row is retryable |
| **IN3** ✅ | CSV/XLSX adapter (upload, parse, header discovery), mapping engine with versions, validation engine, **preview** UI | Upload → map → preview with correct counts, nothing written |
| **IN4** | **IN4a** import settings (D9: what an import may do, match existing, disappeared records stored; NCs add-new-only), file connections without the lifecycle and self-approved (§6.9), references (D10: by source id across the `external_system`, or by Fortress code; resolved in the preview). **IN4b** canonical import functions + importers: suppliers, customers, parts (draft revisions), machines, employees, gauge types, gauges; non-conformances as drafts. **IN4c** UI (settings on the mapping page, reference matching per field, simplified file connection page), tests, journey step | Real import of masters and historical NCs; second import creates nothing; *add new only* never touches an existing record; an unresolved reference is rejected in the preview |
| **IN5** | Production orders; field ownership (*Fortress wins* / *Review*) + the review queue | An order file imports, updates only owned fields, conflicts parked |
| **IN6** | Purchase orders, lines and **goods receipts** (historical mode, both source shapes, reconciliation) | Inventory-transaction export → receipts; supplier performance computed; mismatches reported |
| **IN7** | Generic REST adapter: auth types, pagination styles, incremental cursor, rate limits/backoff, **SSRF defence** | A fake REST server (in tests) imports with pagination and cursor; private targets refused |
| **IN8** | Schedules (D9: daily cron for fetchable sources), records that disappeared (list / make inactive), retries, rejected-record resolution UI, monitoring, integration card on the overview | Scheduled incremental sync recovers from a failure without duplicates |
| **IN9** | Exit check: browser journey (set up → preview → approve → sync → run twice → no duplicates → fix a rejected row), live guardrails, exit report | Brief §14 integration checklist all verified |

Each slice ends with: migration + SQL tests, API + e2e, UI + component tests, sweeps updated, CLAUDE.md updated, nothing pushed until you say so.

## 11. Tests that make this safe (beyond the usual)

- Idempotency per entity (same input twice → zero creates, zero updates).
- Partial failure: one bad row among many; the rest apply; the bad row is retryable after the fix.
- Resume after a timeout mid-run; cursor advances only after commit.
- Cross-tenant: a connection, run or inbox id from another organisation does nothing, for API, cron and the runner.
- Secrets never in responses, logs, errors or staged data.
- SSRF: loopback, private ranges, metadata address, redirect to a private address, DNS that resolves private.
- A connector cannot release a revision, approve, close an NC or hold a lot (the import functions refuse, not just the UI).
- Mapping versions: a run uses the version recorded; editing a mapping never changes a past run.
- Ownership: `qms_wins` field not overwritten; `manual_review` parks a conflict.

## 12. Not building in Phase 5 (brief §15 and Phase 6)

Local SQL agent, SQL Server, SAP, Dynamics, PC-DMIS and any CMM ingestion; webhooks and write-back; two-way sync; a connector marketplace/SDK; Kafka, Redis, a separate worker (unless D2 changes); an arbitrary entity/field/value store; AI mapping suggestions beyond simple header matching; email/SFTP drop folders (scheduled file ingestion arrives as "REST connector that fetches a CSV URL").

## 13. Risks and open points

0. **Size of the map:** about 150 bytes per row plus its index, so 10 million rows is a few gigabytes. The practical limit is the Supabase plan's disk, so staged payload retention matters more than the map. Hash partitioning by organisation is possible later because the key leads with `organisation_id`; not done now.

1. **Cron granularity:** schedules run daily on the production deployment only. Sub-daily sync needs a worker (D2).
2. **Historical import volumes:** 100,000 rows per run may be low for ERP inventory transaction tables; real sample data decides.
3. **Match-only rejections can be noisy** on first import (unknown suppliers/parts). The preview groups them by cause so a customer can import the masters first.
4. **Vault access from the API login** needs a checked, minimal grant path; verified in IN1 before anything else is built on it.
5. **Audit actor for scheduled runs** (§6.6) needs the audit trigger to accept an integration source and initiating user; small change, tested in IN2.
6. **XLSX parsing library:** decided in IN3: no spreadsheet library. `fflate` (small, no dependencies) unzips the workbook and a few lines read the shared strings, inline strings and date styles of the first worksheet (`api/src/integrations/core/file-parsers.ts`); formulas give their cached value. Large or unusual workbooks (pivot caches, several sheets) are out of scope.
7. **File size and storage (IN3):** a Vercel function accepts at most 4.5 MB per request, so the browser uploads to the private `integration-files` bucket and the API downloads and parses it, then keeps its rows in `integration_file_chunks` (1,000 rows each) for the runner. Files up to 25 MB.
