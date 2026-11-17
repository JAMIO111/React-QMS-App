---
title: Inspections and jobs
summary: How control plans drive inspections, how an inspector starts a job and what happens when a reading fails.
group: Everyday work
order: 6
---
In-process inspection starts from a **control plan**: what to measure, with which limits, how often.

## Control plans

Under **Process control → Plans**, a plan is written for a part, a part family or a customer and moves through draft, approval and effective. Each revision lists operations, characteristics (variable, pass/fail or defect count) and sampling rules. A new revision is a copy; a revision in force is never edited.

Part-specific values, such as a drawing's tolerances, are kept on the part's revision and referenced by the plan.

## Start a job

People with permission to record inspections see **Start job** on the home page:

1. Choose the **part**. A message tells you straight away whether one effective plan applies (green) or something is missing (red).
2. Choose the operation from the plan, the machine and, where the plan needs it, the quantity.

The job opens with the requirements copied in, so changing the plan later does not change this inspection. Resume any job in progress from the same card.

## Record readings

Enter each reading as you measure. The database works out whether it passes, using the frozen limits, and shows it in green or red beside the box. If the gauge is out of calibration you are warned, and using it needs a documented override.

Side panes show active **quality alerts**, **documents** in force and recent **non-conformances** for this part and machine, and say when a newer revision of the part is in force.

## When a reading fails

A failure is never ignored and never turned into an NC without you. Before the job can be completed, every failed reading must be either **acknowledged** with a note or **raised** as a non-conformance. You can raise one from the failed readings, with the details prefilled, or add later failures to an NC you already raised from the same inspection.

## CMM files

On a running job, **Import from CMM** reads a report file (PC-DMIS, QIF and table exports), matches its features to your plan's checks, and lets you check the matches before recording. The readings then follow exactly the same rules as typed ones.

## Charts

**Process control → SPC** draws control charts from the readings, with capability indices and signals. A signal raises an alert for people to review. It never raises an NC on its own.
