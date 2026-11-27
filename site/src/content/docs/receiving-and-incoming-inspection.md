---
title: Receiving and incoming inspection
summary: Record purchase orders and deliveries, inspect what arrives, decide what happens to it and raise a non-conformance.
group: Suppliers and customers
order: 31
---
Receiving ties what you ordered to what arrived, makes a lot for it, and checks it against rules you set. These pages are under **Supplier Quality**: **Purchase orders**, **Goods receipts**, **Material certificates** and **Inspection requirements**.

## Purchase orders

Choose **Record an order**. Give the supplier, an order number and the lines: a part of yours or a material in words, a quantity and unit, and a requested date. A line can also have an **agreed** date.

The requested date never changes. If the supplier agrees a new date, use **Agreed date** on the line. A line is late when goods are still outstanding past its agreed date, or its requested date if none was agreed. Use **Close order** when nothing more is expected, or **Cancel order** with a reason.

## Record a delivery

On an order choose **Record a delivery**, or use **Goods receipts** for one with no order. Give the received date and delivery note. Against an order, the outstanding lines are listed with their quantities ready to confirm.

Give a **lot number** on a line that has a part and Fortress makes the received lot. It refuses a lot number already used for that part. Cancelling a receipt keeps the lots it made.

If a scheduled import already owns purchase orders or deliveries, adding them by hand is closed and a notice says where they come from. See [Import your data](/help/import-your-data).

## Write inspection requirements

Under **Inspection requirements**, **Write a requirement** says what to inspect and for whom. It can apply to a supplier, a part, a part family, a supplier classification or a risk level. The most specific one wins, in that order: part, family, supplier, classification, risk.

Choose how much to inspect (every unit, a fixed sample, a percentage, a sampling plan by lot size, first delivery only, or every Nth delivery), the level (increased, normal, reduced or skip) and the control plan operation that holds the checks. A requirement is a draft until someone else with approval rights chooses **Approve**. One that reduces inspection needs a reason of at least 10 characters.

A part with a critical characteristic, or with no usable control plan, is always inspected in full. Without an approved requirement, deliveries are accepted without inspection.

## Inspect and decide

When a line needs inspection, Fortress records why and puts its lot on hold. On the receipt, choose **Start inspection** on the line. It opens a normal inspection from the part's control plan, so readings behave as they do anywhere else. See [Inspections and jobs](/help/inspections-and-jobs).

Then choose **Decide**: **Accept**, **Hold**, **Reject** or **Accept on conditions**. Give a reason. For a rejection you can enter the **quantity rejected**; empty means the whole line. Accepting needs an acceptable inspection where one is required, and conditional acceptance needs approval rights.

## Raise a non-conformance

**Raise non-conformance** on the line asks for a title, what is wrong, severity and quantity affected. It makes one non-conformance with the source goods receiving and links it to the line. See [Raise a non-conformance](/help/raise-a-non-conformance). An existing one can be linked from its own page with **Link to a received line**.

## Material certificates

**Add certificate** on a line, or **Record a material certificate** on the register, takes the supplier, number, kind (mill test report, certificate of conformance and so on), heat number, specification and the file. Someone who manages supplier quality then accepts or rejects it, once. A rejection needs a note.

## Good to know

- Certificates are information. They never stop a decision.
- Prices, over-receipt warnings and quarantine locations are not built.
- The supplier's **Incoming quality** tab shows open orders and the latest deliveries.
