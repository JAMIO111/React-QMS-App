---
title: Calibration
summary: Set up gauge types and gauges, record calibrations and handle a gauge that fails.
group: Everyday work
order: 13
---
The Calibration module tracks every gauge, when it is next due and the readings from each calibration.

## Set up gauge types

Under **Settings → Data Management → Calibration**, add a gauge type. A type has a **code**, a name, a calibration interval and the **checks** a calibration records (for example, a measured value with a nominal and tolerance, or a pass/fail attribute).

You can link a **calibration procedure**, which is a controlled document of the built-in Calibration procedure type, so people always work from the current revision.

New gauges copy their type's checks. If you add a check to a type later, **Apply the checks to them** adds it to existing gauges.

### Checks that depend on the gauge's range

A general type such as "External micrometer" can cover a 0–25 mm and a 75–100 mm gauge, because a check can be placed **at a percentage of each gauge's own range** instead of at a fixed value. In the check's pop-up choose **Where on the gauge**:

- **A fixed value**: the same nominal and unit on every gauge of the type, as before.
- **A % of the gauge's range**: for example 50 %. 0 % is the gauge's range minimum and 100 % its maximum, so on a 50–100 mm micrometer 50 % is 75 mm. The point is in the gauge's own unit and is rounded to the gauge's resolution.

Then choose how the allowed error (the **tolerance**) is given:

- **A fixed value**, such as ±0.004 mm. The two sides may differ.
- **A % of the span (full scale)**, for example ±1 % of the range, the way pressure gauge classes are written.
- **A % of the reading**, where the allowed error grows with the value checked.
- **A fixed value plus a % of the reading**, for example ±(0.003 mm + 0.01 % of the reading), the way many micrometer and caliper standards are written.

Fortress does not ship the standards' tables: you choose the check points and read the tolerance from your gauge maker's datasheet, the standard for that kind of gauge or your own requirement. The optional **Where the limit comes from** box (for example "ISO 3611") is shown beside the limits on the gauge and on every calibration record.

**Add evenly spaced points** makes several checks at once, for example five points from 0 % to 100 %, all with the same tolerance. **Try it with a range** shows what the type's checks become for a range you type (points, limits and how each was worked out) and saves nothing.

A gauge of a type with checks given as a percentage of the range **needs its range and unit**. When you add such a gauge, the range and unit are required and the form lists the checks the gauge will get. Each gauge gets ordinary points and limits, marked **From range** with how they were worked out, so calibration records, reports and imports work as for any other check. If you change the gauge's range later, its checks keep their old numbers and a notice says they are **out of date**; **Recalculate range-based checks** (calibration managers) works them out again. Calibrations already recorded keep the limits they were recorded with. Editing the numbers of a check by hand makes it an ordinary fixed check on that gauge.

When you apply a type's checks to existing gauges, any gauge without a range or unit cannot take a range-based check; the result lists those gauges and why, so you can fix them and apply again.

## Add gauges

Under **Calibration → Gauges** add each gauge. A **gauge type** is required (the red star marks it), and a gauge keeps one once chosen. Under **Location and custody** you can choose the **site**, a **department**, optionally the **machine** the gauge is fixed to (choosing one sets the site, and a machine at another site is refused), and a typed **location** such as "Inspection room, cabinet 3". The register shows the next due date, and the dashboard shows what is due, overdue or quarantined. You can show a **Machine** column and filter the register by machine.

## Record a calibration

Open a gauge and choose to record a calibration. Checks worked out from the gauge's range show how their limits were worked out, and the limits are kept with the readings. Once you enter a reading for one check, every check needs one, and the page names the ones still missing. For each check, enter the **as-found** reading, and an **as-left** reading if the gauge was adjusted. Each box turns green with a tick when in tolerance and red with a cross when not. The outcome is worked out for you from where each reading ended up: **fail** if any reading is out of tolerance in its final state (as-left if you adjusted it, otherwise as-found), **pass** if every reading was in tolerance as found, otherwise **adjusted**. After a calibration is saved, correcting or deleting it needs the calibration manager's permission.

External calibrations also take a certificate number and files.

## When a gauge fails

A failed calibration **quarantines** the gauge and a passing one releases it. Putting a quarantined gauge back into use by hand needs a reason. The gauge always shows the dates and result of its **latest** calibration, so a calibration entered with an older date does not move it back, and deleting the only calibration clears its dates. The record can raise a non-conformance in one click, linked to the calibration. An **impact report** lists the inspections that used the gauge, so you can see what to re-check.

## Importing

Gauge types and gauges can be imported from a file. Calibration records themselves are not imported.
