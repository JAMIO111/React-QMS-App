---
title: FMEA
summary: Build a design or process FMEA, rate it with your own model, get it approved and tie its controls to the control plan.
group: Quality system
order: 26
---
An FMEA records what could go wrong, how bad it would be, how likely it is and how you would catch it. Fortress keeps each FMEA as one record with numbered revisions (rev A, rev B), like a controlled document. It informs and never blocks anything: a missing or out-of-date FMEA does not stop an inspection or a release.

## Set up the rating model first

Open **Settings → Data Management → FMEA**. The model holds your ten-level scales for severity, occurrence and detection (separately for design and process), whether risk is judged by **RPN** or by an **action priority** grid, the thresholds, and a severity level at or above which a cause always needs attention.

Fortress starts you with neutral scales and RPN. It does not ship any standard's published scale wording or priority grid. If you hold a licence, you can import your own grid from a CSV file, and Fortress tells you if the file leaves any combination uncovered. Changing the model needs approval rights and saves a new version with a reason. **Try a rating** shows the result the database gives for any three levels.

## Start an FMEA

Choose **FMEA → FMEAs → Start an FMEA**, or **Start an FMEA** on a non-conformance, 8D, audit finding, supplier corrective action or change page, which fills in the title and scope. Pick design or process, an owner and what it covers (parts, part families, control plans, machines, suppliers, customers or operation codes). You can start from an FMEA already in force as a base. The copy is yours, and later changes to the base do not reach it. The page can show what the base has changed since.

## Build the analysis

On the revision page, build the structure: system, sub-system and component for a design FMEA, or process item, step and work element for a process FMEA. Under each lowest item add:

1. A **function** (what it must do).
2. **Failure modes**, optionally tied to a failure mode in your non-conformance register.
3. **Effects** with a severity, and **causes** with prevention and detection controls and occurrence and detection ratings.

The database works out RPN, priority and whether a cause needs attention. The **Still needed** list says what a draft lacks. A cause that needs attention must have an action or a written reason why nothing more is done.

## Actions

Add an action to a cause, assigned to a person or an employee. They finish it with what was found and revised ratings. **My actions** lists yours.

## Approval and revisions

Choose **Submit for approval**. The approver you named approves from a date, or sends it back with a comment. The person who prepared it cannot approve it. Once in force, **Start a revision** copies the analysis and can take finished actions in. Reviews are recorded on the FMEA page, with a due date.

## Link to the control plan and the evidence

- **Carry to the control plan** ties a control on a cause to a characteristic on a plan. The coverage card shows which causes needing attention are covered by the plan in force.
- The evidence card shows non-conformances that actually happened against your failure modes, and failures nobody foresaw. It reads the register as you. Without parts, families or machines in the scope it counts the whole register and cannot list unforeseen failures.

## Form sheet and dashboard

**Form** shows the analysis as a paper-style table, with one row per cause. Print it or export a CSV. **FMEA → Dashboard** shows what is in force, what is waiting, overdue reviews and actions, and causes needing attention.

## Good to know

- A submitted or in-force revision cannot be edited. Start a new revision.
- Exporting to Excel (.xlsx) is not built. The CSV opens in Excel.

See also [SPC charts and alerts](/help/spc-charts-and-alerts) and [Run an 8D](/help/run-an-8d).
