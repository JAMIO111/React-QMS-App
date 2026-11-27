---
title: SPC charts and alerts
summary: Read control charts, save a baseline, understand signals and capability, and acknowledge SPC alerts.
group: Everyday work
order: 14
---
Statistical process control in Fortress works from the readings your inspectors already record. There is no separate data entry. Charts are in **Process Control → SPC Charts**, alerts in **Process Control → SPC Alerts**, and comparisons in **Process Control → Machine & family analysis**. You need permission to read SPC to see them.

## Choose a chart

On **SPC Charts**, choose a **Part** and a **Characteristic**. The list shows how many readings each one has and which already have a baseline. The chart type comes from how the control plan sets up the characteristic:

| Data | Chart |
| --- | --- |
| Measurements, charted as individual readings | I-MR (individuals and moving range) |
| Measurements, charted in subgroups | X-bar/R (subgroup mean and range) |
| Pass/fail checks | P chart (proportion failed), or NP chart (number failed) |
| Defect counts | C chart or U chart |

Fortress picks C when every subgroup holds the same number of units, and U when they differ. For P and defect charts, **Subgroup (one point is…)** sets what one point means: one inspection, one day, one lot or one production order. For a P chart, **Show as** switches to NP and **NP subgroup size (checks)** sets the size, or leaves it to be calculated.

You can narrow the chart by **Machine**, **From**, **To** and **Lot**. Only compatible data is charted: one part, characteristic, operation, unit, chart type and specification. The **Left out of this chart** card says what was excluded and why.

## Baselines

Until you save a baseline, the chart shows trial limits calculated from the points on screen. A baseline fixes the limits.

1. In the **Baseline (control limits)** panel, choose the data to calculate from: all of it, the first N, or a date range.
2. Add a note if you like, then choose **Calculate and save baseline**.

A new baseline replaces the current one. The old limits stay in the history. A baseline with too few points is marked provisional. P and NP charts share one baseline. Saving baselines needs permission to manage SPC.

## Signals

The chart marks points that break the Western Electric rules:

- Rule 1: one point beyond 3σ
- Rule 2: two of three beyond 2σ, same side
- Rule 3: four of five beyond 1σ, same side
- Rule 4: eight in a row on one side of the centre line

A moving range or range above its upper limit is also a signal. A signal means the process is probably behaving differently, so look into it. It does not mean product is nonconforming, and a signal never raises a non-conformance by itself.

## Capability

For I-MR and X-bar/R charts with specification limits, the **Process capability** card shows Cp and Cpk from the chart's within-subgroup spread, and Pp and Ppk from the overall spread of the readings shown. It gives a Cpk verdict: excellent (1.67 or more), capable (1.33 or more), marginal (1.00 to 1.33) or not capable (below 1.00). Capability is not shown with fewer than 10 readings, with no specification limit, or for pass/fail and count charts. It warns below 30 readings and when the chart has signals.

## Compare machines or parts

**Machine & family analysis** compares one characteristic between machines, for one part or a whole part family, or between the parts of a family. Measured values are compared against their tolerance, so parts of different sizes can share one view. A group is called higher or lower only when it is clearly different from all the others together.

## SPC alerts

When a reading is recorded, Fortress evaluates the charts for the characteristics just measured, using the saved baseline or trial limits. A new signal becomes an alert. Retests and corrections do not raise alerts.

People who may manage SPC are notified in the app by default, except the person who recorded the reading. You can also choose email in **Settings → Notifications**.

1. Open **SPC Alerts**. The tabs are **Open**, **Acknowledged** and **All**.
2. Choose **Acknowledge** on an alert.
3. Write **What was done** and confirm.

An alert is acknowledged once, with a note, and is then kept as it is. Alerts are never deleted.

## Good to know

Alerts do not stop anyone recording readings and do not raise non-conformances. If a signal means product is affected, raise a non-conformance in the usual way. See [Raise a non-conformance](/help/raise-a-non-conformance) and [Inspections and jobs](/help/inspections-and-jobs).
