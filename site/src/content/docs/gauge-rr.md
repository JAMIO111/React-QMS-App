---
title: Gauge R&R studies
summary: Plan, run and complete a measurement system study, and see which characteristics have no evidence.
group: Everyday work
order: 15
---
A measurement system study shows whether a gauge and the people using it are good enough for the characteristic they measure. Studies are under **Calibration → Gauge R&R**. They are information only: a poor result never changes a gauge's status and never stops anyone recording a reading.

## Choose the kind of study

| Kind | Use it to |
| --- | --- |
| Gauge R&R (crossed) | Have several appraisers measure the same parts several times, to see how much of what you see is the gauge and the people rather than the parts |
| Type 1 (bias and repeatability) | Measure one part with a known reference value again and again with one gauge, giving bias, repeatability and Cg and Cgk |
| Attribute agreement | Check whether people agree with each other and with the standard on pass/fail decisions for samples whose true answer is known |

## Plan a study

1. On **Calibration → Gauge R&R**, choose **Plan a study**. You can also start from a gauge's page.
2. Choose the **Kind of study** and the **Gauge**.
3. Optionally choose a **Part** and a **Characteristic of the part**. Its name, unit and limits are filled in from the part's released revision. Otherwise fill in **What is measured**, **Unit**, **Nominal** and the limits.
4. Set the numbers of appraisers, parts or samples and trials. New studies start with the usual design: 10 parts, 3 appraisers and 3 trials for Gauge R&R, 25 readings for Type 1, and 30 samples, 3 appraisers and 3 trials for attribute agreement.
5. Choose appraisers from the Employees register, or type a name.
6. For a Type 1 study, enter the **Reference value of the part**. For attribute agreement, set the right answer for every sample.

You need permission to manage calibration to plan, start, cancel or repeat a study.

## Run the study

Choose **Start collecting**. Fortress makes the run sheet: every reading to take, in a random order for each appraiser. From then on the design is locked.

- Enter each reading as you take it. A box saves when you leave it or press Enter.
- Use the appraiser tabs, and the **By part** layout if you prefer a table of parts by trials.
- **Paste readings** reads a spreadsheet selection or a CSV file. Fortress says which rows it cannot place, and saves nothing until you record what it found.

People who may record calibration can enter readings. While collecting, the page shows an analysis so far, which changes as readings arrive.

## Complete it

When every reading is in, choose **Complete the study**.

1. Choose **Your conclusion**: **Accepted**, **Accepted with conditions** or **Not accepted**. The numbers inform your judgement but do not decide it.
2. Write **Why**.
3. Set **Valid until**, or leave it empty for twelve months.

The result is then frozen with the method version used, so it cannot change later. The page shows the variation figures, the analysis of variance, the charts and a verdict of **Acceptable**, **Marginal**, **Not acceptable** or **Not judged**. For Gauge R&R the verdict follows the usual bands: under 10 per cent acceptable, 10 to 30 marginal and over 30 not acceptable, with at least five distinct categories. For Type 1, Cg and Cgk of 1.33 or more is acceptable.

**Report** opens a printable record. **Repeat the study** makes a new draft with the same design and no readings. A study past its valid-until date is shown as expired.

## Coverage

Switch from **Studies** to **Coverage** to see where you have no evidence. It lists critical and major characteristics on control plans in force, the gauge each was measured with in the last 12 months, and what that gauge's latest completed study says. States run from **No study**, **Expired** and **Not accepted** to **Marginal** and **Acceptable**. The default view shows the ones that need attention. **Plan a study** on a row starts a study with the gauge and the plan's limits filled in.

A badge also appears beside each critical or major characteristic on the control plan revision page.

## Good to know

- Coverage needs permission to read control plans and inspections. Without it, the page says so instead of showing zeros.
- You can set up a workflow rule that tells people when a study is completed. See [Workflows and tasks](/help/workflows-and-tasks).
- Linearity and stability studies are not built.
- A completed study is read-only. If something was wrong, repeat it.

See also [Calibration](/help/calibration) and [SPC charts and alerts](/help/spc-charts-and-alerts).
