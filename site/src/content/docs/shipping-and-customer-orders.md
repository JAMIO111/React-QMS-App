---
title: Customer orders and shipments
summary: Record customer orders and what you ship against them, and read on-time, in-full and customer PPM figures.
group: Suppliers and customers
order: 33
---
This is the customer side of purchasing and receiving. You record what a customer ordered, what you shipped, and Fortress works out how well you delivered and what came back.

## Customer orders

Open **Shipping → Customer orders → Record an order**. Give the customer, your order number and, if they use one, the **customer's order number**. Each line needs one of your parts, a quantity and the date the customer asked for. You can add a **confirmed date** later, which is the date you promised them. The requested date never changes and the confirmed one keeps its history.

On the order page you can **Close order** when nothing more is expected, or **Cancel order** with a reason.

## Shipments

Choose **Record a shipment** on the order, or from **Shipping → Shipments**. The outstanding lines are filled in ready. Enter the date shipped, a delivery note and, per line, the quantity and the **lot** it came from. A shipment names a lot that already exists, by number. It never makes one.

Over-shipping is allowed and shown. A shipment does not have to name an order, but it is then left out of on-time and in-full. Cancel a whole shipment with a reason. If a lot that went out is on hold or closed, the shipment page says so. It does not stop anything.

Shipped, outstanding and late are worked out when you look. See [Production and traceability](/help/production-and-traceability) for lots.

## Customer returns

On a non-conformance whose source is **customer**, the Disposition section has **Generate an RMA number**. It proposes a disposition for all or part of the quantity still to decide, with a number such as RMA-26-0001. It is approved and cancelled like any other disposition. There is no RMA register, and receiving the parts back against the number is not built.

## Customer quality dashboard

**Shipping → Dashboard** covers a period you choose.

| Figure | How it is worked out |
| --- | --- |
| On-time delivery | Shipment lines shipped on or before the order line's date. Lines with no order are left out. |
| In full | Order lines whose date falls in the period and that shipped at least the ordered quantity, not over 110%. |
| PPM (reported) | Units on customer complaints in the period, divided by units shipped, times one million. |
| PPM (by lot) | The same, but only units traced to lots shipped to that customer. |
| Returned under RMA | Approved RMA dispositions, shown beside PPM and never added to it. |

If nothing shipped, PPM shows as not available, not zero. Complaints counted are customer-source NCs past draft and not cancelled. The date a customer measures against defaults to the requested date, and there is no screen to change it yet. Someone who cannot read non-conformances sees the figures withheld, not zeros.

## When an import owns the records

If a scheduled import is active for customer orders or shipments, adding them by hand is closed, so no record is there twice. The page says which connection owns them. Switch off the schedule in **Settings → Integrations** to type them again. See [Import your data](/help/import-your-data).

## Good to know

- Importing customer orders and shipments is built. Reconciling shipped totals against the source is not.
- The customer portal's figures do not yet include PPM.
