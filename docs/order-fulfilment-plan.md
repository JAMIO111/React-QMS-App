# Orders and fulfilment — customer orders, shipments and the customer performance dashboard

**Status:** drafted 2026-11-26 from the generic model discussed with the owner; **SH1–SH2 are built first** (customer orders and shipments, database and API), then the screens (SH3), the imports (SH4) and the customer dashboard (CD1–CD2). Decisions below are **proposed until the owner has seen the first client's tables** (their customer order, order line and inventory transaction tables); where those tables would change a decision it says so. Nothing here changes a supplier figure or blocks work: like the rest of Fortress it informs.

## 1. The model

Every business has **order documents** (what was promised) and **movements** (what actually happened). Table names and layouts differ between ERPs; those two ideas do not. Fortress captures the quality-relevant slice of each, never the ERP's whole schema, and **never stock balances, locations, valuation or a bill of materials** (that is an inventory system, a different product).

| | Document (header + lines) | Movement (fulfilment event) | Status today |
|---|---|---|---|
| Buying | `purchase_orders` + `purchase_order_lines` | `goods_receipts` + `goods_receipt_lines` (receipt against an order line, makes the received lot) | **Built** (SQ4a, imports IN6) |
| Making | `production_orders` + `production_operations` | `lots` (produced) and `serial_numbers` | **Built** (Phase 3) |
| Selling | `customer_orders` + `customer_order_lines` | `shipments` + `shipment_lines` (shipment against an order line, of an existing lot) | **This plan** |
| Returns | NC dispositions (`customer_return`, RMA) and receipt dispositions (rejected) | — | Built; **return movements are not built** (§9) |

**Receipts are not rebuilt.** The receipt side already has the shape this plan wants (document, line, requested vs agreed date, received quantity, lot, idempotent client key, cancelled as a whole with a reason, imports with the source's transaction id). Shipments are its mirror on the customer side. If the first client's inventory transaction table shows the receipt shape needs to change (for example a single combined ledger), the importers split it (§6), not the tables.

### Principles

1. **Facts are append-only and carry their source.** A shipment line is never edited; a shipment is cancelled as a whole with a reason (as receipts are). Records that came from an ERP name the connection and the source's own id (the import map already does this).
2. **Orders are promises, shipments are facts, everything else is derived.** Shipped, outstanding, late and in full are worked out on read (never stored), exactly as received and late are for purchase orders.
3. **The minimum is customer, part, quantity, date.** Everything else (order line, lot, site, delivery note) is optional, so a business with no customer orders, or one that ships partial or drop-ship, still gets PPM and delivery counts. A shipment with no order line is **counted but left out of on-time and in-full** (the receipts' "unmatched" rule).
4. **The customer's date is kept as asked, and the confirmed date as it stands.** `requested_on` never changes; `agreed_on` is the latest confirmed date, changed with an audit trail. Which one on-time is measured against is a **setting** (§5), as for suppliers.
5. **A shipment ships a lot that exists.** It never creates a lot (receipts do, because received material has no other origin). A shipment line may name a produced lot of the same part (optional); naming one lets a customer defect be traced to what was shipped (§5, cohort PPM).
6. **Writes are functions only**, `shipping.manage`, errors **`QM038` → `409 shipping_rule`**, another organisation's id is `P0002` → 404, everything audited, nothing deleted, row-level security by `shipping.read`.

## 2. Decisions (proposed)

| # | Decision | Why |
|---|---|---|
| OF-D1 | Separate tables per direction with the same shape, not one `orders` table with a `kind`. | Supplier vs customer, work orders have operations; foreign keys, row-level security and imports stay plain. |
| OF-D2 | Customer order lines are **parts of ours** (a `part_id`, required). No "material in words" as on purchase lines. | A customer buys products; PPM and traceability need the part. |
| OF-D3 | `customer_orders.customer_reference` holds **the customer's own purchase order number** (optional). | It is what the customer quotes on a complaint and what an ERP export carries. |
| OF-D4 | A shipment names the customer; its lines may name order lines of **that customer's order** only, and parts must agree. | Same cross-checks as receipts. |
| OF-D5 | Shipped quantity is positive; returns are **not** negative shipments. A customer return stays an RMA disposition on the NC (quantity already recorded there). | Avoids two sources for the same bad parts. |
| OF-D6 | Over-shipment is allowed and shown ("over by N"), never refused. | Real shipments run over; refusing would push people back to spreadsheets. |
| OF-D7 | Permissions `shipping.read` / `shipping.manage`; same role grants as receiving (manage: owner, admin, quality manager, quality engineer, inspector; read adds viewer). A new module `shipping` ("Shipping", group Quality) with package rows so it is priced (Observer view, Contributor view, Controller full), as the every-feature-priced test requires. | Consistency with receiving. |
| OF-D8 | Site: the shipment's `site_id` defaults to the organisation's only site (receipts do the same). | Same rule. |

## 3. Tables (SH1)

`customer_orders` (`order_number` unique per organisation ignoring case, `customer_id`, `customer_reference`, `status` open | closed | cancelled with a reason, `ordered_on`, notes), `customer_order_lines` (`line_number`, `part_id`, `quantity_ordered`, `unit`, `requested_on`, `agreed_on`, `status`), `shipments` (`SH-YY-NNNN` per organisation and year via `app.pad_number`, `customer_id`, optional `customer_order_id` and `site_id`, `shipped_on` (not in the future), `delivery_note`, notes, status shipped | cancelled with a reason, `client_key` unique per organisation for a retried create), `shipment_lines` (`line_number`, optional `order_line_id`, `part_id`, `quantity_shipped`, optional `lot_id`, notes; frozen). Composite `(id, organisation_id)` keys, audit trigger, `app.stamp_created`, `app.touch_updated`, `app.prevent_organisation_change`, no table writes, no deletes.

Functions: `app.create_customer_order`, `set_order_line_agreed_date`, `close_customer_order`, `cancel_customer_order(reason)`, `record_shipment(customer, order, site, shipped_on, delivery_note, notes, lines, client_key) → {id, created}`, `cancel_shipment(id, reason)`.

## 4. API (SH2)

`api/src/shipping/`: `GET|POST /customer-orders` (list: `q`, `customerId`, `status` open (default) | closed | cancelled | all, `late=true`, `sort`, `order`, `page`, `pageSize`), `GET /customer-orders/lookup?customerId&q`, `GET /customer-orders/{id}` (lines with `quantityShipped`, `quantityOutstanding`, `late`, `daysLate`, first and last shipped; its shipments), `POST …/close|cancel`, `PATCH /customer-order-lines/{id} {agreedOn}`, `GET|POST /shipments` (list: `q`, `customerId`, `customerOrderId`, `lotId`, `partId`, `status`, `from`, `to`), `GET /shipments/{id}`, `POST …/cancel`. `@Versioned` on the order GET and the line PATCH. Written like `api/src/receiving/`.

## 5. The customer figures (the dashboard, CD1–CD2)

All worked out by the database for one customer and period, then added up for the dashboard (as `app.supplier_performance` is for suppliers), so a customer's own page, the dashboard and any later scorecard cannot disagree.

| Figure | Definition |
|---|---|
| **Shipped units** | Σ `quantity_shipped` of non-cancelled shipments in the period. |
| **On-time delivery** | Shipment lines against an order line shipped on or before that line's due date (the policy's date), ÷ matched lines. Lines with no order line are "unmatched" and left out. Open order lines already past due count as a warning only. |
| **In full** | Per order line due in the period: shipped by (due + grace after) within the tolerances; a short line that can still ship is "pending" and left out. |
| **Customer NCs** | Live NCs naming the customer (past draft, not cancelled), **source `customer`** (not internal scrap), detected in the period: count, by severity, open now with age, **quantity affected**, cost. |
| **PPM (period)** | Σ `quantity_affected` of those NCs ÷ shipped units × 1,000,000. Label: "defects reported in the period ÷ units shipped in the period" (it lags: a bad lot shipped in March may be reported in May). |
| **PPM (by lot)** | Where an NC names an affected lot and a shipment line names the same lot: affected units on that lot ÷ units shipped from it. Shown as a second figure with its coverage, never mixed with the period figure. |
| **Returns** | Σ quantity of approved `customer_return` (RMA) dispositions in the period, and as a share of shipped units. **Separate from PPM**: a complaint and its RMA describe the same parts, so PPM uses the NC quantity and returns are shown beside it. |
| **Coverage** | Shipment lines with / without an order line, with / without a lot; customers with shipments in the period. Shown on the page so a gap in the data is visible. |

Settings, as for suppliers: a model (versions) with the date policy `requested | agreed`, grace days before and after, in-full tolerances; **per-customer overrides** in a later slice. Customers with no shipments in the period show "no shipments recorded", never a PPM of zero.

The dashboard mirrors the supplier quality dashboard (`/Customer-Quality`): a hero, delivery performance gauges, PPM and NC quantity, severity trend, **customer by customer** ranked lists and an attention table, using `DashboardGraphics.jsx`, `useDashboardPeriod` and the skeleton.

## 6. Imports (SH4)

Two new importable kinds, `customer_order` (one row per order line; key = order number, `keySuffix: 'lineNumber'`) and `shipment` (add only, never matched; key = the source's transaction id; one document per customer and delivery note makes one shipment, as goods receipts do). **A source's single inventory-transaction table is split by the mapping**: a row whose type says "shipment" and whose reference names a customer order is a shipment line, one that says "receipt" against a purchase order is a receipt line (the existing `goods_receipt` kind); "Leave this row out" (formula-friendly) skips the rows a kind does not take, and the filter step can do the same before mapping. Running totals on an order line (some ERPs keep only "quantity shipped so far") follow the existing received-quantity pattern. The drift test classifies every column.

## 7. Slices

| Slice | What | Status |
|---|---|---|
| SH0 | This plan | done |
| SH1 | Migration + SQL test: module, permissions, packages, tables, functions, sweep seeds, guardrails list | next |
| SH2 | API + e2e + both sweeps | |
| SH3 | Screens: customer orders register and page, shipments register and page, record a shipment, menu group, a Shipments tab on nothing else yet | |
| SH4 | Imports: `customer_order` and `shipment` kinds, drift test | |
| CD1 | `app.customer_performance` (+ per-customer settings later), API `GET /customer-quality/dashboard` | |
| CD2 | Dashboard page, home area, trace line, exit check and journey step | |

## 8. Questions for the owner

1. The first client's tables: how does a transaction row say shipment, and which order line does it name? (Decides whether one importer is enough.)
2. May people enter shipments by hand, or import only for now? (Built with a small manual form either way; the question is how much to polish it.)
3. Which date does the first client measure delivery against: the date the customer asked for, or the date confirmed to them?

## 9. Not built, on purpose

Stock levels and locations, prices and invoicing, pick lists and packing, carriers and tracking, returns as negative movements (RMA dispositions already hold the quantity), shipments creating lots, a customer-facing shipment view in the portal (a later, curated slice once the figures are trusted), per-customer scoring models in SH1–SH4 (CD1 starts with one organisation model).
