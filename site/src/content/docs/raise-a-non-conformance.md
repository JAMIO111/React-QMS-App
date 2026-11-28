---
title: Raise a non-conformance
summary: Record a problem, contain it, decide what happens to the product and close it, with the rules that keep it honest.
group: Everyday work
order: 10
---
A non-conformance (NC) records something that did not meet its requirement. All of them live in one register under **Non-Conformance → Register**.

## Start with the source

Choose **New NC** and pick where it came from. Source and category are separate ideas: the source says where it was found, the category says what kind of problem it is.

The sources are internal, customer, supplier, internal audit, external audit, production inspection, final inspection, calibration, goods receiving, engineering and management review. A customer NC needs the customer. A supplier NC needs the supplier.

NCs raised from an inspection, an audit finding, a calibration or a received delivery set their own source and prefill the details.

## Fill in what is needed

- **Category** is required to open an NC. The source suggests one, and you can change it.
- **Severity** starts at Minor.
- **Where detected** and **Detected by** say where and who. Customer, external audit and management review NCs do not ask where.
- The **More details** card holds any custom fields your organisation added.

Save as a draft any time. The stage bar shows what is **still needed** to move to the next stage.

## The stages

An NC moves Draft, Open, Contained, Investigating, Dispositioned, Awaiting closure and Closed. Some stages have gates:

- **Containment** must be resolved: every action done with a result note, or a recorded reason none was needed. Actions are quarantine, sorting, stop shipping, notifying a customer or supplier, recall or other.
- **Disposition** must cover the whole quantity affected before the NC is dispositioned.

## Dispositions

Anyone who can edit the NC proposes a disposition: rework, repair, scrap, use as is, return to supplier or concession. The quantities can never add up to more than the quantity affected.

An approver (owner, admin or quality manager) approves it. A concession needs a reference. Once approved it is frozen. On a customer NC you can **Generate an RMA number**, which creates a proposed return disposition for the quantity you choose.

## Affected lots and costs

Name the production lots that are affected, with a quantity for each. An NC that names lots needs approved dispositions that cover each lot.

Add **costs** as a quantity times a unit cost. Totals follow your organisation's currency.

## Investigate and close

The Investigation card lets you start an **8D** from the NC or link an existing one. See [Run an 8D](/help/run-an-8d). An NC cannot be closed while a linked 8D is still running.

Everything you change is in the history, with who and when. Changing the source later needs a reason.
