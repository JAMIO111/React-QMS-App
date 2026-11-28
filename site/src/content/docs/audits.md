---
title: Audits
summary: Define audits, schedule them, carry them out, record findings and raise non-conformances from them.
group: Quality system
order: 20
---
The **Audits** module covers the whole cycle: the audit you define, the schedule it creates, the record of each time it is carried out, and the findings that come from it. The pages are **Dashboard**, **Audit schedule**, **Audit templates**, **Audit records** and **Audit findings**. People who may manage audits define them, and people who may perform audits carry them out.

## Define an audit

1. Go to **Audit templates** and choose **New audit**.
2. Under **About this audit**, enter a **Title**, a **Type** (process, product, system, supplier, housekeeping or 5S, layered process, or other), a **Pass mark (%)** and a **Purpose**.
3. Choose **How often**: every day, week, month, quarter, six months or year, every N days, or on demand. For a scheduled audit set **First due** and a **Grace period (days)**, the days after the due date before it counts as missed.
4. Under **Relevant to**, choose the machines, operations, departments and suppliers it covers. Whoever carries out the audit later says which of them it was done on.
5. Write the **Procedure**, then build the **Checklist**.

You can name an **Expected auditor**. It is shown, not enforced: anyone who may perform audits can do it.

## Checklist questions

Each question chooses how it is answered, and the audit record shows exactly that control. There are ten types:

- Yes / No, Compliant / Non-compliant, Pass / Fail and Yes / No / N/A, each with a defined passing answer
- Numeric, with an optional unit and limits
- Measurement, with a nominal, tolerances and a unit
- Multiple choice, where each option is marked acceptable or not
- Rating, on a scale you choose, with an optional lowest acceptable rating
- Text, a note that is not scored
- Evidence required, which needs at least one photograph or document

Only a question that can fail can be marked **Critical**. An audit passes only when every critical question passes and the score reaches the pass mark. The score is passes divided by passes plus fails, with not applicable answers left out.

## Versions

Every change to what the audit says (its questions, procedure, pass mark and what it is relevant to) becomes a new version, and Fortress asks **Why is this changing?**. Changing only the schedule or the expected auditor needs no reason. The **Version history** card on the audit shows what changed in each version and which records were done against it. Records keep the version they were started on. You can also **Retire** an audit with a reason, and **Reactivate** it later.

## Schedule

**Audit schedule** shows each due audit as a slot, as a list or a calendar. A slot is upcoming, in progress, overdue, missed, done or skipped. Choose **Start audit** on a slot to begin. People who manage audits can **Skip** a slot with a reason and **Put back** a skipped one. **Start an unscheduled audit** carries one out now.

## Carry out an audit

1. Start the audit from a slot or from the audit's page.
2. Tick what it was **Carried out on** if the audit lists anything.
3. Answer the questions. Answers save as you go. A failed answer needs a note, and an evidence question needs a file.
4. When the **Still needed** list is empty, choose **Complete audit**. The score and result are worked out and the record is frozen.

If you started it by mistake, choose **Abandon** and give a reason.

## Findings

On a failed answer, choose **Create finding**. You can also use **Add finding** for something not tied to a question. Choose a **Classification**, describe **What was found**, and optionally name the requirement, an **Owner** from the Employees register and a **Due** date. The classifications start as Major non-conformity, Minor non-conformity, Observation and Opportunity for improvement. Admins can manage them under **Settings → Data Management → Audits**.

A failed critical answer needs a finding before the audit can be completed.

On a finding classified as a non-conformity, choose **Create non-conformance**. Fortress makes a draft internal non-conformance from the finding's text, once only. The finding can be closed when that non-conformance is closed. Findings can also be closed, withdrawn or reopened, each with a reason, and can hold evidence files. See [Raise a non-conformance](/help/raise-a-non-conformance).

## Dashboard

The **Dashboard** shows whether audits are being done as planned, the on-time and pass rates, open and overdue findings, the questions that fail most, and **Coverage**: every machine, operation, department and supplier an active audit names, and when a completed audit last covered it. Choose the period at the top.

## Good to know

- Reviewer approval and auditee acknowledgement of findings are not built.
- A completed record cannot be edited. Carry out a new audit as the correction.
