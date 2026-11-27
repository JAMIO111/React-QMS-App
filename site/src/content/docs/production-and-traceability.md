---
title: Production and traceability
summary: Record production orders, lots and serial numbers, link them to jobs and non-conformances, and trace everything for one order, lot or serial number.
group: Everyday work
order: 16
---
Production orders, lots and serial numbers give your quality records something to attach to. Link a job or a non-conformance to them, and you can answer "what happened to this lot?" in one page. The pages are under **Production**: **Orders**, **Lots**, **Serial numbers** and **Traceability**. Anyone who can read inspections or non-conformances can read them. Owners, admins, quality managers and quality engineers can add and change them.

## Production orders

1. Go to **Production → Orders** and choose **New order**.
2. Enter the **Order number**, which must be unique in your organisation, then choose the **Part** and the **Quantity planned**.
3. Optionally set **Revision released on**, **Customer**, **Site** and **Due date**.

The order number, part and site cannot change once the order is created. Move an order along with the buttons on its page: **Release**, **Start**, **Complete**, **Close**, or **Cancel order** with a reason. Add the route with **Add operation**, and start and complete each operation. An order cannot be completed while an operation is pending or in progress. Closed and cancelled orders are frozen.

## Lots

Choose **New lot** on **Production → Lots**. Enter a **Lot number**, unique for the part, and the **Part**. Set **Origin** to **Produced** or **Received**. A produced lot can name its production order, and a received lot its supplier and **Received on** date.

A lot is **Open**, **On hold** (with a reason), **Released** or **Closed**. Lots from received material are also made for you when a goods receipt line names a lot number.

## Serial numbers

Choose **New serial numbers** and pick the part. Add them one at a time, as a pasted list, or as a range with a prefix, a **From** and **To** number and the **Digits** to pad to. You can make up to 500 at once, and they are created all together or not at all. A serial number is **In production**, **Completed** or **Scrapped** (with a reason).

## Link your work to them

- **Jobs:** the job page has a **Production records** block with pickers for the order, lot and serial number. Picking one fills in what it implies, such as the part, or the order a lot belongs to.
- **Non-conformances:** the NC form has the same pickers. With lots switched on, an NC can also list its **Affected lots**.

A lot, order and serial number you link must agree about the part. Fortress shows a warning, never a block, when you link to a lot on hold, a closed or cancelled order, or a scrapped serial number.

## Trace

Open **Production → Traceability** and type part of an order, lot or serial number, then choose a match. You can also follow the **Trace** link on a job, inspection or non-conformance, the **Trace** column in the registers, or **Everything on this order** on an order page.

The page shows the order, its lots and serial numbers, the inspections, the non-conformances with their containment, dispositions and 8Ds, the changes that cover the part, the FMEAs, and the part approvals. It works from an order alone, with no lots needed. A section you may not read says so, so you are never told "none" by mistake. **Print or save as PDF** keeps a copy. FMEA and part approval lines show where things stood on the day the record was created in Fortress.

## Settings

Under **Settings → Organisation → Production**, people who manage the organisation can switch:

- **Track lots and serial numbers**: off for shops that work to work orders only. Lots and Serial numbers then disappear from the menu and pickers, and nothing is deleted.
- **Let operators make an order from a job**: people who only record inspections can add an order, but not a lot or serial number, when it is not listed.
- **Require a production order to complete a job**: starting and recording are not affected.

**Link existing records** turns work orders, lots and serial numbers typed as text on older inspections and non-conformances into real records. Choose **Preview** first and check the report before you apply it.

## Good to know

- A lot cannot be released or closed, and an order cannot be completed or closed, while an open non-conformance names it.
- Production orders can also be imported. See [Import your data](/help/import-your-data).
- Receiving material is covered in [Receiving and incoming inspection](/help/receiving-and-incoming-inspection), and jobs in [Inspections and jobs](/help/inspections-and-jobs).
