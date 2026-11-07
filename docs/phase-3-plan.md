# Phase 3 — Manufacturing traceability — plan

**Status:** agreed (decisions D1–D6 in §6); **TR1 built** (migration `20251210100000_production_traceability.sql`, **not applied live yet**); TR2–TR6 not started · **Brief:** `docs/design-brief.md` §6.1, Phase 3 (line 882) · **Builds on:** master data (parts, revisions, machines, customers, suppliers), inspections and the job hub, NCs with containment and disposition, calibration, CAPA

**Exit criteria (brief):** a quality record can be traced to the relevant manufacturing context without relying on free-text references alone.

## 1. Where we are

Production context exists only as **free text**, copied around by hand:

| Record | Free-text fields today |
|---|---|
| `inspection_records` (and so the job hub) | `work_order`, `lot`, `lot_size`, `serial`, plus real FKs to `machine_id`, `operation_code`, part and plan revisions |
| `nonconformances` | `work_order`, `purchase_order`, `customer_reference`, `lot_number`, `serial_number`, `quantity_affected`, FKs to part, revision, customer, supplier |
| Calibration | gauges only (equipment), no production context |
| Dispositions / containment | a quantity, not the lots it applies to |

Consequences: the same lot is spelt three ways, "which NCs and inspections touch lot X?" cannot be answered reliably, a disposition cannot say *which* items are scrapped, and nothing links a job to the order it belongs to. Already in place and reusable: parts, part revisions (with corrections), part families, customers (`part_customers`), suppliers, `machines`, `gauges`, the operations on control plans, the audit trail and outbox.

## 2. Scope (brief Phase 3)

| Brief item | Proposal |
|---|---|
| Production orders | `production_orders`: order number (unique per organisation), part (+ the revision it was released on, optional), customer (optional), site, planned quantity, due date, status planned → released → in progress → completed → closed, or cancelled. Created by hand now; `external_system` / `external_id` columns are **reserved** so Phase 5 imports map onto the same row (brief §7.5: the ERP will own the number). |
| Operations | `production_operations`: the order's route — sequence, operation code (matches the control plan's `operation_code` where one exists), machine (optional), status. Light: it records what is planned and where it ran; it is not scheduling or MES. |
| Lots | `lots`: lot number (unique per organisation and part), part, origin **produced** (optionally from an order) or **received** (supplier), quantity, status active / on hold / released / closed. A lot on hold is a flag for people, never a block. |
| Serial numbers | `serial_numbers`: serial (unique per organisation and part), optional lot and order, status. Created singly, as a range, or on the fly from a form. |
| Product / customer links | A part already has customers (`part_customers`). Orders and lots carry customer and supplier where relevant. `products` / `product_bom` are **not** built (see §7). |
| Equipment links | **No new table.** Equipment = `machines` + `gauges`. Operations name a machine; inspection readings already record the gauge used; the traceability view joins them. |
| Traceability views | Search by order, lot or serial → one page showing the part and revision, the order and its operations, lots and serials, every inspection, NC, 8D, containment and disposition touching it, machines and gauges used, customer and supplier. Backward (what was this made from / on / measured with) and forward (what else is affected). |

## 3. Design principles

1. **Link, don't replace.** Records keep their free-text columns as the snapshot of what was typed; new nullable FKs (`production_order_id`, `lot_id`, `serial_id`) are the real link. Nothing existing breaks, and a record with only text still works.
2. **Pick or create, never retype.** Pickers search existing orders/lots/serials and can create one inline (a small dialog). This is how free text stops growing.
3. **Master data patterns** (CLAUDE.md): table-level INSERT + `app.stamp_created()`, column-level UPDATE, no DELETE (status instead), `audit_changes`, RLS with `app.has_permission`, site-scoped where the record has a site, guardrails and both tenancy sweeps. Lifecycle changes (release, close, hold) through SECURITY DEFINER functions where a rule applies.
4. **Composite FKs** (`id, organisation_id`) as everywhere else; a lot's part must match the order's part; a serial's lot must belong to the same part.
5. **Information, not blocking.** A held lot or closed order warns on the job hub and NC form, it does not stop an inspection or NC (consistent with alerts and revision banners).
6. **Do not build Phase 4–6 early:** no ERP import, connector tables, BOM genealogy or shipments.

## 4. Slices

- **TR0 — decisions and plan** (this document).
- **TR1 — database.** Migration: permissions `production.read` / `.manage`; `production_orders`, `production_operations`, `lots`, `serial_numbers`; link columns on `inspection_records` and `nonconformances` (FKs, same-part/same-organisation checks by trigger); lifecycle functions; audit; RLS; SQL tests; guardrails + sweeps.
- **TR1 — built.** Migration, SQL tests (`production_traceability.test.sql`, 12 mutation checks each fail the test), guardrails and tenancy sweep seeds. Notes: an order is created `planned` whatever the caller sends and
  cannot complete while an operation is pending or in progress; its part, number and site never change; a closed or cancelled order (and a closed lot, a scrapped serial) is frozen. A lot is `open` → `on_hold` (reason) /
  `released` → `closed`; a serial `in_production` → `completed` → `scrapped` (reason). Part, lot and order must agree: picking a **serial** fills its lot, order and part, picking a **lot** its order and part, and any
  two links that are both given must match (`QM017` → `409 production_rule`, to map in TR2). Inspections get `production_order_id` / `lot_id` / `serial_id`, set only by `app.set_job_links(inspection, jsonb)` while the job runs
  (keys `productionOrderId`, `lotId`, `serialId`: present-with-null clears, absent keeps; needs `inspection.record` and `production.read`); NCs get the same columns through their ordinary UPDATE grant. In both, picking fills
  the typed `work_order` / `lot` / `serial` text. Permissions `production.read` (all six roles) and `production.manage` (owner, admin, quality manager, quality engineer). No backfill yet (TR3), no outbox events yet.
- **TR2 — API and registers.** `api/src/production/`: `/production-orders`, `/lots`, `/serial-numbers` (page-based lists with filters, get, create, patch, status actions, range create for serials, `lookup` endpoints for pickers). Master Data–style registers and detail pages (`/Production/Orders`, `/Production/Lots`, `/Production/Serials`), menu group "Production", e2e + sweep.
- **TR3 — link the quality records.** Order / lot / serial pickers (`PartPicker` style, create inline) on Start job, the job hub, the inspection page, and the NC form; text columns filled from the picked record; banner for held lot / closed order; backfill of existing text (decision D1).
- **TR4 — affected lots on NCs.** `ncr_affected_lots` (NC, lot, optional serials, quantity); dispositions and containment actions can name the lot(s) they apply to; the "quantity affected" and disposition quantity rules extend per lot. Raise-from-inspection pre-fills the lot.
- **TR5 — traceability.** `GET /traceability?type=order|lot|serial&id=` (and by number search), page `/Traceability` with the relationship view, "where is this lot / serial used" panels, links back from the order, lot, NC and inspection pages; print view for a recall-style report.
- **TR6 — exit check.** Live guardrails + advisors, browser journey (create order → lot → job → fail → NC naming the lot → disposition per lot → trace from the lot shows all of it), exit report, CLAUDE.md.

Each slice is complete and tested before the next, as in earlier phases.

## 5. Permissions (proposed)

`production.read` (everyone who can read inspections or NCs), `production.manage` (owner, admin, quality manager, quality engineer). Operators with `inspection.record` may **create a lot/serial/order inline from a job or NC form** only if they also hold `production.manage`; otherwise they pick existing ones (decision D5). Site-scoped through the order/lot's site.

## 6. Decisions (agreed)

Agreed: D1 backfill and link; D2 produced + received lots; D3 single level, no genealogy; D4 `production.manage` creates, others pick; D5 order optional; D6 as proposed.

| # | Question | Proposal |
|---|---|---|
| D1 | Existing free text (`work_order`, `lot`, `serial`, `lot_number`, `serial_number`): what happens to it? | **Backfill:** create an order/lot/serial for each distinct value per organisation + part and link; text stays. Alternative: leave old records text-only, link only new ones. |
| D2 | Lot scope | **Produced and received lots** (received name a supplier, so a supplier NC can name the incoming lot). Alternative: produced only. |
| D3 | Genealogy (which component lots went into which assembly lot — `product_bom`) | **Not in Phase 3** (single level: record → order/lot/serial). Say if you need assemblies now. |
| D4 | Who may create orders/lots/serials inline from a form | Anyone with `production.manage`; others pick only (operators on the shop floor would normally pick an order released by planning). |
| D5 | Must a job (inspection) be tied to a production order | **Optional**, an organisation setting later (`require_production_order`) if wanted. |
| D6 | Order status | planned → released → in progress → completed → closed / cancelled, moved by people (no automatic completion). |

## 7. Out of scope (later)

ERP / CSV import and sync (Phase 5, columns reserved), `products` and `product_bom` assemblies and component-lot genealogy, shipments and customer deliveries, scheduling, barcode hardware beyond a text field that accepts scanner input, inventory quantities, unit conversion.

## 8. Risks

- **Backfill quality** (D1): free-text variants (`WO-12`, `wo12`) will make separate orders; the backfill matches case-insensitively and trimmed, reports what it created, and is idempotent. A merge tool is out of scope.
- **Existing tests and the journey** create NCs and inspections with text only; they must keep passing unchanged (principle 1).
- **Pushing the API before the migration breaks endpoints that select the new columns** (as with earlier migrations): apply, then push.
