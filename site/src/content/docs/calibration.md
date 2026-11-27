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

## Add gauges

Under **Calibration → Gauges** add each gauge. A **gauge type** is required (the red star marks it), and a gauge keeps one once chosen. Under **Location and custody** you can choose the **site**, a **department**, optionally the **machine** the gauge is fixed to (choosing one sets the site, and a machine at another site is refused), and a typed **location** such as "Inspection room, cabinet 3". The register shows the next due date, and the dashboard shows what is due, overdue or quarantined. You can show a **Machine** column and filter the register by machine.

## Record a calibration

Open a gauge and choose to record a calibration. Once you enter a reading for one check, every check needs one, and the page names the ones still missing. For each check, enter the **as-found** reading, and an **as-left** reading if the gauge was adjusted. Each box turns green with a tick when in tolerance and red with a cross when not. The outcome is worked out for you from where each reading ended up: **fail** if any reading is out of tolerance in its final state (as-left if you adjusted it, otherwise as-found), **pass** if every reading was in tolerance as found, otherwise **adjusted**. After a calibration is saved, correcting or deleting it needs the calibration manager's permission.

External calibrations also take a certificate number and files.

## When a gauge fails

A failed calibration **quarantines** the gauge and a passing one releases it. Putting a quarantined gauge back into use by hand needs a reason. The gauge always shows the dates and result of its **latest** calibration, so a calibration entered with an older date does not move it back, and deleting the only calibration clears its dates. The record can raise a non-conformance in one click, linked to the calibration. An **impact report** lists the inspections that used the gauge, so you can see what to re-check.

## Importing

Gauge types and gauges can be imported from a file. Calibration records themselves are not imported.
