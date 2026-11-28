---
title: Change management
summary: Raise an engineering change, assess its impact, get it signed off, carry it out with linked tasks and check it worked.
group: Quality system
order: 25
---
One change record follows a change from the request to the check that it worked. It is an engineering change request while it is assessed and becomes an engineering change notice once the board approves it. It informs people and keeps the evidence. It does not stop anyone releasing a revision or running a job.

## Raise a change

Open **Change → Changes** and choose **Raise a change**. Give it a title, a **Type of change** (Product design, Process, Tooling or equipment, Material or supplier, Measurement or inspection, Documentation or QMS, or Software or other) and an **Urgency**. Expedited is shown first and worded as urgent, but it is still assessed and approved in full. Then say **What is changing** and **Why**.

Choose **What it covers**: parts, part families, machines, suppliers, customers, production orders or operations. Add drawings, customer requests and emails under **Files**.

You can also raise a change from the record that caused it. A **Changes** card on non-conformances, 8Ds, audit findings, risks, parts, machines, suppliers, documents and control plan revisions offers **Raise a change**, with the title and covers suggested. Accepted document change requests, 8D actions and management review decisions have the same button. A customer's or supplier's request sent through the portal arrives as a draft change.

## Assess it

1. Choose **Submit for assessment**. A draft needs what is changing, why, and something it covers. A **Still needed** list shows what is missing.
2. In **Impact assessment**, mark each area **Affected** (with how) or **Not affected**. There are twelve to begin with, including design, process and control plan, inspection, gauges, documents, training, supplier, customer and stock.
3. In **Cut-in point**, say from when it applies: no fixed point, a date, a production order, a lot or a serial number, and what to do with stock already made. This is recorded and shown. It is never enforced.
4. In **Customer approval**, say whether the customer must approve. Record their answer, or choose **Ask the customer** to put it to them in the portal. Their answer fills in the same record.

## Board and sign-off

1. Choose **Choose the board**: pick the functions that must agree (Quality, Engineering, Production, Purchasing and Sales and customers are provided, and you can edit the list) and who signs for each. People who cannot sign are greyed out.
2. Choose **Send to the board** once every area is assessed and the board is chosen. The person who raised the change cannot sign it unless **Settings → System Preferences** allows it.
3. Each signer finds it in **Change → My changes** and chooses **Approve** or **Send back** with a reason.

A send-back returns the change to assessment, and everyone signs again next time. When the last signer approves, the change is approved. **Take back from the board** (with a reason) pulls it back while it is waiting. **Change notice** shows the whole change as one printable page.

## Carry it out

Once approved, choose **Add a task** for each piece of work: who does it, by when and for which area. A task can **Start a revision** of a part, control plan, document or FMEA, or **Link a revision** you already have. Fortress then reads that revision's live status. A task on a revision can be finished only once that revision is in force. The change moves to Implementing while any task is open and to Verifying when all are done.

## Check it worked

At Verifying, choose **Record the check**. Say whether it was effective and what you found. Effective closes the change. Not effective sends it back to Implementing so a task can put it right. A change cannot close while the customer's approval is still required, requested or rejected, or while a linked revision is not in force.

## Follow it

- **Change → Dashboard** shows changes by stage, sign-offs waiting, overdue tasks, changes past their cut-in date, those waiting for the customer and recent closures.
- **My changes** lists sign-offs waiting for you and tasks given to you. The menu shows a count.
- Trace pages show changes against the cut-in point of an order, lot or serial number.

## Good to know

- A change can be cancelled with a reason until it is closed. Cancelling cancels its open tasks.
- Types, signing functions and impact areas are set under **Settings → Data Management → Change**.
- Reading changes, signing them and managing them are separate rights.
- Product design, process, tooling and material changes show a prompt to start a [part approval](/help/ppap) for customers who require one.
