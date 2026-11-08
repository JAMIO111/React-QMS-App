# Phase 3 — Manufacturing traceability — plan

**Status:** agreed (decisions D1–D6 in §6); **TR1 built** (migration `20251210100000_production_traceability.sql`, applied live); **TR2 built**; **TR3 built** (migration `20251211100000_production_links.sql`, **not applied live yet**); TR4–TR6 not started · **Brief:** `docs/design-brief.md` §6.1, Phase 3 (line 882) · **Builds on:** master data (parts, revisions, machines, customers, suppliers), inspections and the job hub, NCs with containment and disposition, calibration, CAPA

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
  **Built.** `api/src/production/` (`production.schemas|service|controller.ts`): `GET|POST /production-orders`, `GET|PATCH /production-orders/{id}` (detail carries `operations`), `POST /production-orders/{id}/operations`, `PATCH /production-operations/{id}`,
  `GET|POST /lots`, `GET|PATCH /lots/{id}`, `GET|POST /serial-numbers`, `GET|PATCH /serial-numbers/{id}`, and `GET …/lookup` for pickers (open records only; `includeClosed=true` for all). Lists are page-based (`q`, comma-separated `status`, per-resource id filters, `sort`, `order`, `page`, `pageSize`).
  A status move is a `PATCH` with `status` (+ `statusReason` for a cancel / hold / scrap): the database decides and answers `409 production_rule` in words. Serial numbers are created one, as a list, or as a range (at most 500, all or nothing); an order takes the organisation's only site when none is named.
  UI `src/components/production/` (menu group **Production**: `/Production/Orders`, `/Production/Orders/:id`, `/Production/Lots`, `/Production/Serials`): one generic `RegisterPage` (URL filters, status chips, server sort and paging, column prefs, CSV) behind three registers, add/edit dialogs
  (`OrderDialog`, `LotDialog`, `SerialDialog` with one / list / range), `StatusMoves` (buttons per status, a reason dialog where the database wants one), the order page with its operations, and `pickers.jsx` (`OrderPicker`, `LotPicker`, `SerialPicker` for TR3). Hooks `useProduction.js`, helpers `lib/production.js`.
  Checks: 16 API e2e tests + sweep entries (mutation checks: 5 of 6 caught; the sixth, `production.manage` on the lot route, is also refused by row-level security, so both layers answer 403), 28 unit tests (10 mutation checks, 9 caught; the tenth is an equivalent mutant), browser journey step with screenshots `37`–`43`.
  The browser found nothing broken, but the review of its screenshots caught three things now fixed: the raw id in the breadcrumb on the order page, serial numbers made together listed out of order, and a "required" mark on fixed fields.
  Not in TR2: the pickers are not used yet (TR3), production is **not a subscription module** (no `features` row maps `production.*`, so the subscription never restricts it, like master data), no operations reorder/delete (status `skipped` instead).

- **TR3 — link the quality records.** **Order first**: the work order is the primary link, lot and serial are optional extras. Order / lot / serial pickers (`PartPicker` style) on Start job, the job hub, the inspection page and the NC form; choosing an order fills the part (and the lot/serial pickers narrow to it); text columns filled from the picked record; banner for held lot / closed order; backfill of existing text (decision D1). The order picker can **create the order inline** for people allowed to (D4, amended §6); the lot and serial pickers appear only when the organisation uses them (D7). Needs a `GET /jobs/{id}` field and `PUT /jobs/{id}/production-links` over `app.set_job_links`.
- **TR4 — affected lots on NCs.** `ncr_affected_lots` (NC, lot, optional serials, quantity); dispositions and containment actions can name the lot(s) they apply to; the "quantity affected" and disposition quantity rules extend per lot. Raise-from-inspection pre-fills the lot. **The lot is optional**: without lots the NC's quantity affected and its dispositions stand against the production order ("scrap 3 of the 24 on WO-154789"), exactly as today; the per-lot rules apply only to NCs that name lots. Raise-from-inspection also pre-fills the order.
- **TR5 — traceability.** `GET /traceability?type=order|lot|serial&id=` (and by number search), page `/Traceability` with the relationship view, "where is this lot / serial used" panels, links back from the order, lot, NC and inspection pages; print view for a recall-style report. **It must work from an order alone**: for a shop with no lots or serials the order is the whole story (its jobs and inspection results, NCs and 8Ds raised on it, gauges and machines used, containment and dispositions), and the order page gets the same "everything on this order" view.
- **TR3b — fit for shops without lots or serials** (small, with TR3). (1) SPC subgroups gain **"by order"** beside inspection / day / lot (`subgroup=order` on `GET /spc/chart` and `POST /spc/baselines`, URL `?basis=order`), using `production_order_id`, falling back to the typed work order. (2) Organisation setting **`organisation_settings.use_lots_and_serials`** (default on, so nothing changes for anyone today; Settings → Organisation): when off, the Lots and Serial numbers menu entries, columns, filters and pickers are hidden and only the order is offered; the data model and API are unchanged (lots and serials simply never exist). (3) The Start job dialog offers the order (optional, or required if the organisation sets `require_production_order`, D5).

  **TR3 built (TR3a database, TR3b API, TR3c UI).**
  - *Database* (`20251211100000_production_links.sql`, tests `production_links.test.sql`, 12 + 2 mutation checks): `organisation_settings.use_lots_and_serials` (default on), `allow_inline_orders` and `require_production_order` (default off); `app.create_order_inline` (production.manage, or inspection.record when the setting allows it; orders only);
    a job cannot be **completed** without an order when the organisation requires one (checked in `app.inspection_record_rules`, so it holds whatever route completes it); `spc_baselines` accept the `order` subgroup basis;
    `app.system_backfill_production_links(org, dry_run default true)`, executable only by the API login: it reads the typed work order, lot and serial of inspections and NCs (only where the matching link is empty), makes the orders, lots and serials they name and links the records, **without touching any typed text**
    (the link triggers skip the text fill, and the inspection rules let only the three link columns change while `app.production_backfill` is on, so completed inspections and closed NCs are reached). Nothing is guessed: a work order typed against several parts is skipped and listed, a record with no part or an unusable number is counted and left alone, existing orders and lots (same number, any case) are reused, a lot takes an order only when every record naming it names the same order,
    a lot named only by supplier NCs is a received lot; created orders are `released` with a note and a planned quantity taken from the largest quantity on an inspection (else 1); a record that disagrees with an existing production record is counted as a conflict and left alone; it can be run again.
  - *API*: `links` (`productionOrder`, `lot`, `serial`) on inspections (list and detail; list filters `productionOrderId|lotId|serialId`) and NCs (detail; create/patch take `productionOrderId|lotId|serialId`); `PUT /jobs/{id}/production-links`; `POST /jobs` takes `productionOrderId`; `POST /production-orders/inline`; `POST /production/backfill {dryRun}` (organisation.manage; the system call is labelled `backfill` in the audit trail); the three settings in `GET|PATCH /organisations/current`;
    SPC `subgroup=order` (chart and baseline; the order is the linked order's number, else the work order as typed, matched in any case; checks without one are left out and counted as `no_order`). 15 e2e tests (`production-links.e2e-spec.ts`) and 8 mutation checks.
  - *UI*: the job hub has a **Production records** block (order picker with "Not listed? Make a new order", lot and serial pickers only when the organisation uses them, notices for a lot on hold or a closed order; the typed work order, lot and serial lock when a record supplies them); the Start job dialog offers the order (needed to start when the organisation requires one and the person can pick); the inspection page links the order and shows the notices;
    the NC form has the same pickers (picking a lot brings its order and part, as the server will); Settings → Organisation → **Production** (the three switches, and "Link existing records": Preview, then Link them after a confirmation); the Production menu hides Lots and Serial numbers when they are switched off; SPC offers "One production order". 29 new unit tests; the journey has a work-orders-only step (screenshots `44`–`50`), including the backfill reaching a finished inspection.
  - *Not in TR3*: the inspection register has no order column or filter yet; the SPC lot option stays visible when lots are switched off; the NC register does not filter by order (TR5 will); an operator still cannot make an order from the NC form (only from a job).

- **TR6 — exit check.** Live guardrails + advisors, browser journey (create order → lot → job → fail → NC naming the lot → disposition per lot → trace from the lot shows all of it), exit report, CLAUDE.md.

Each slice is complete and tested before the next, as in earlier phases.

## 5. Permissions (proposed)

`production.read` (everyone who can read inspections or NCs), `production.manage` (owner, admin, quality manager, quality engineer). People with `production.manage` may **create an order, lot or serial number inline from a job or NC form**. Operators who hold only `inspection.record` pick existing ones, unless the organisation turns on **`allow_inline_orders`** (D4, amended): then an operator may create an *order* (not a lot or serial) from the job's order picker, because a shop that types its work order at the machine cannot wait for planning to enter it; the order is created `planned`/`released` as normal and the creator is on its audit trail. Until ERP import (Phase 5) orders are entered by hand. Site-scoped through the order/lot's site.

## 6. Decisions (agreed)

Agreed: D1 backfill and link; D2 produced + received lots; D3 single level, no genealogy; D4 `production.manage` creates, others pick (**amended, see below**); D5 order optional; D6 as proposed. **Added for shops that work to work orders only (proposed, to confirm):** D7 lots and serial numbers are optional everywhere and can be switched off per organisation; D8 operators may create an order inline when the organisation allows it; D9 SPC can group by order.

| # | Question | Proposal |
|---|---|---|
| D1 | Existing free text (`work_order`, `lot`, `serial`, `lot_number`, `serial_number`): what happens to it? | **Backfill:** create an order/lot/serial for each distinct value per organisation + part and link; text stays. Alternative: leave old records text-only, link only new ones. |
| D2 | Lot scope | **Produced and received lots** (received name a supplier, so a supplier NC can name the incoming lot). Alternative: produced only. |
| D3 | Genealogy (which component lots went into which assembly lot — `product_bom`) | **Not in Phase 3** (single level: record → order/lot/serial). Say if you need assemblies now. |
| D4 | Who may create orders/lots/serials inline from a form | Anyone with `production.manage`; others pick only (operators on the shop floor would normally pick an order released by planning). |
| D4 (amended) | Operators and work-order-only shops | Planners create orders by default; an organisation can switch on `allow_inline_orders` so people with only `inspection.record` can create an **order** (never lots or serials) from the job's picker. **To confirm.** |
| D7 | Lots and serial numbers for shops that do not use them | Optional in every table, API and form already; new setting `use_lots_and_serials` (default on) hides their menu, columns, filters and pickers. **To confirm.** |
| D8 | Inline order creation setting | `allow_inline_orders`, default off. **To confirm.** |
| D9 | Grouping SPC points when there are no lots | Add **by order** as a subgroup basis. **To confirm.** |
| D5 | Must a job (inspection) be tied to a production order | **Optional**, an organisation setting later (`require_production_order`) if wanted. |
| D6 | Order status | planned → released → in progress → completed → closed / cancelled, moved by people (no automatic completion). |

## 7. Out of scope (later)

ERP / CSV import and sync (Phase 5, columns reserved), `products` and `product_bom` assemblies and component-lot genealogy, shipments and customer deliveries, scheduling, barcode hardware beyond a text field that accepts scanner input, inventory quantities, unit conversion.

## 8. Risks

- **A work-order-only shop must never be second-class.** Every slice is checked against a scenario with **no lots and no serials** (a job and an NC on "WO-154789 × 24", traced from the order alone). A browser journey step covers it in TR6.

- **Backfill quality** (D1): free-text variants (`WO-12`, `wo12`) will make separate orders; the backfill matches case-insensitively and trimmed, reports what it created, and is idempotent. A merge tool is out of scope.
- **Existing tests and the journey** create NCs and inspections with text only; they must keep passing unchanged (principle 1).
- **Pushing the API before the migration breaks endpoints that select the new columns** (as with earlier migrations): apply, then push.
