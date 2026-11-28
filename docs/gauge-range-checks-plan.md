# Gauge type check points as a percentage of the gauge's range, and how their tolerance is worked out

Status: **RC1 (the migration and its SQL test) is built and committed locally, and applied live 2026-11-28 (RCX)**; **RC2 (API) is built and committed locally** (2026-11-28); **RC3 (screens, help guide) is built and committed locally.** RCX done: applied live on the owner's go, history row added, live checks clean. Decisions R1–R12 below were **agreed by the owner on 2026-11-28 as proposed**.
Builds on `docs/calibration-plan.md`. Read that first for the tables named here.

## 1. The problem

A gauge type is a template: a code, a default interval, a procedure document and a list of **checks** (`gauge_type_characteristics`).
When a gauge is created, the database copies the type's active checks onto the gauge (`app.gauge_copy_characteristics`), and from then on the gauge owns its copies.

Each template check has a **fixed nominal and a fixed tolerance** (for example 25.000 mm ± 0.004). That is fine for a type that is already specific ("External micrometer 0–25 mm"), but:

- A general type ("External micrometer") cannot work: a 0–25 mm and a 75–100 mm micrometer need different check points, and the type cannot say so.
- The only ways round it today are one type per range (many types) or editing every gauge's checks by hand after creating it (slow, easy to get wrong, inconsistent between gauges).
- Fixed tolerances cannot express how most gauge specifications are written. There is no single "gauge makers' standard at 50 % of range"; the allowed error comes from the maker's datasheet, a standard for that kind of gauge (for example ISO 3611 micrometers, ISO 13385-1 calipers, ISO 463 dial indicators, ISO 3650 gauge blocks, EN 837-1 pressure gauges, ISO 6789 torque tools, ISO 7500-1 force) or the organisation's own requirement, and it is written in one of four ways:

| Style | Typical gauges | Example |
|---|---|---|
| Fixed value | Micrometers, gauge blocks | ±0.004 mm anywhere in the range |
| % of span (full scale) | Pressure gauges | class 1.0 = ±1 % of span |
| % of reading | Torque tools, force, balances | ±4 % of the indicated value |
| Fixed + % of reading | Calipers, indicators, many digital length instruments | ±(3 µm + 0.01 % of the reading), which makers write as ±(3 + 0.1·L) µm with L in mm (0.1 µm per mm is 0.01 %) |

The standards are named from general knowledge; **their figures are not in the product** and must not be (they are the publishers' and the makers'). The organisation types the limits from its own datasheets and standards, as with the FMEA rating tables and the PPAP requirement tables.

## 2. What we want

- A type can say, per check: *"place this point at X % of the gauge's own range"*. Each gauge then gets its own real values worked out from **its** range when it is created.
- A type can say, per check, how the tolerance is worked out: a fixed value, a percentage of the span, a percentage of the reading, or a fixed value plus a percentage of the reading. The tolerance basis is independent of the point basis (a torque tool check at a fixed 20 N·m can still be ±4 % of the reading).
- A check can record **where its limit came from** ("maker's spec", "ISO 3611") so an audit can see it, and each gauge check and each recorded reading keeps that note and a plain-words description of how its limits were worked out.

Nothing else about calibration changes: a gauge still owns its copies, a reading still copies its limits from the gauge's check at the moment it is recorded, and past readings never move.

Mixed types stay possible: the same type can hold range-based points, fixed points and pass/fail (attribute) checks.

## 3. How it behaves

| Question | Behaviour |
|---|---|
| Existing types and gauges | **Unchanged.** Every existing check is a fixed point with a fixed tolerance. No backfill. |
| The arithmetic for a point | **nominal = range_min + (percent ÷ 100) × (range_max − range_min)**, so 0 % is the range minimum (not zero) and 100 % is the range maximum: on a 50–100 mm gauge the points 0, 25, 50, 75, 100 % are 50, 62.5, 75, 87.5, 100. **Span = range_max − range_min.** The range must have range_max above range_min. |
| Decimal percentages | A point's percentage may have up to **three decimals**, because micrometer calibration usually uses uneven sizes (a common set is 2.5, 5.1, 7.7, 10.3, 12.9, 15.0, 17.6, 20.2, 22.8 and 25 mm on a 25 mm span, which is 10, 20.4, 30.8, 41.2, 51.6, 60, 70.4, 80.8, 91.2 and 100 %; the same set shifted by the range minimum works out to the same percentages). The organisation checks its own sequence against the standard it works to. |
| The arithmetic for a tolerance | **Fixed value:** ± the value (the minus and plus sides may differ). **% of span:** ± percent ÷ 100 × span. **% of reading:** ± percent ÷ 100 × the check's nominal (its absolute value). **Fixed + % of reading:** ± (the fixed part + percent ÷ 100 × the nominal). Every basis except the fixed value is symmetric. Worked example, a ±(3 + 0.1·L) µm instrument (L in mm), which is a fixed part of 0.003 mm plus 0.01 % of the reading: at 50 mm the tolerance is 3 + 5 = ±8 µm, so 49.992 to 50.008; at 5 mm it is ±3.5 µm. |
| A tolerance that works out to nothing | **Refused** with the check named ("a percentage of the reading gives no tolerance at this point; use a fixed value plus a percentage of the reading"). The case that matters is a 0 % point on a gauge whose range starts at 0 with a "% of reading" tolerance. The type page's preview shows the problem before anyone creates a gauge. |
| Rounding | The nominal is rounded to the gauge's **resolution** when it has one (a point the gauge can actually show), otherwise to four decimal places. The tolerance is worked out unrounded and stored to six decimal places. |
| Units | A range-based point uses the **gauge's own unit** (no conversion between a type in mm and a gauge in inches). A fixed point keeps its own unit; a fixed point with a "% of span" tolerance takes the span in the gauge's unit and so needs the gauge's range. |
| What is stored on the gauge | **Ordinary values** (`nominal`, `tolerance_minus`, `tolerance_plus`, `unit_code`), so every reading, report and import that reads a gauge check works without knowing about ranges. Also a `derivation` in words ("50 % of range; ±(0.003 mm + 0.01 % of reading)") and the `tolerance_source` note, both copied from the moment it was made. |
| A gauge with no range, type needs one | Creating or retyping it is **refused** ("This type places its checks across the gauge's range: enter the range and unit"), the same way a missing gauge type is refused. Needed when any active check of the type uses a span percentage for its point or its tolerance. A "% of reading" tolerance on a fixed point needs no range. Gauges from before this rule are never blocked from other edits. |
| Range changed later | The gauge's checks **do not change by themselves**. The gauge page shows a notice and a **Recalculate range-based checks** action (needs `calibration.manage`), which uses the type's *current* check definition and the gauge's *current* range. Past readings keep the limits they were recorded with. |
| A person edits a range-based check on one gauge | It becomes an ordinary fixed check on that gauge (it stops following the range; its derivation is cleared and the screen says so). |
| Type edited afterwards | As today, **nothing propagates**. "Apply the checks to them" adds missing checks to existing gauges; it now works out range-based ones too, and counts the gauges that could not be given one because they have no range. |
| Recorded readings | Each reading keeps the `tolerance_source` and `derivation` of the check it was recorded against, with its limits, so a recorded calibration still shows where its limits came from after the type changes. |
| Preview | The type page and the gauge form can show "what these checks become for a 50–100 mm gauge" before saving, with any problem named. The answer comes from the database, nothing is saved. |

## 4. Data model (one migration, additive)

`gauge_type_characteristics` (the template) gains:

- `nominal_basis text NOT NULL DEFAULT 'value' CHECK (nominal_basis IN ('value', 'span_percent'))`. When `span_percent`, `nominal` holds the percentage (0 to 100, at most three decimals) and `unit_code` is NULL (the gauge's unit is used).
- `tolerance_basis text NOT NULL DEFAULT 'value' CHECK (tolerance_basis IN ('value', 'span_percent', 'reading_percent', 'value_plus_reading_percent'))`. What `tolerance_minus` and `tolerance_plus` hold depends on the basis, and a CHECK holds each shape: **value** — absolute values, which may differ; **span_percent** and **reading_percent** — the same percentage in both; **value_plus_reading_percent** — the same fixed part in both.
- `tolerance_reading_percent numeric` — the proportional part, present only for `value_plus_reading_percent` and above zero.
- `tolerance_source text CHECK (tolerance_source IS NULL OR length(tolerance_source) <= 200)` — free text, optional.
- The `kind_fields` CHECK is rewritten to cover all of the above; an attribute check still has none of them.

The columns overload `nominal` and `tolerance_*` with percentages when a basis says so; the alternative (separate columns for each component) was considered and rejected as more columns for the same information. Template checks are not importable and appear in no reporting view, so nothing else reads the overloaded columns.

`gauge_characteristics` (the gauge's copy) gains:

- `follows_range boolean NOT NULL DEFAULT false` — true only for a copy worked out from a check whose point or tolerance is a span percentage and not edited by hand.
- `derivation text`, `tolerance_source text` — descriptive, copied at the moment of copying; the screen never lets a person edit `derivation`.

`calibration_readings` gains `derivation text` and `tolerance_source text`, copied from the characteristic in `app.calibration_reading_rules` and frozen with the other copied limits.

No change to `calibrations`, imports of gauges (`rangeMin`, `rangeMax` and `unitCode` are already importable), reporting views, PPAP or Gauge R&R.

Functions (all `SECURITY DEFINER`, fixed `search_path`, `QM006` → `409 calibration_rule`):

- `app.resolve_type_check(template_id, range_min, range_max, unit, resolution)` → `{ nominal, toleranceMinus, tolerancePlus, unit, derivation, problem }` — the one place the arithmetic lives. Pure; used by the trigger, the apply route, the recalculation and the preview.
- `app.gauge_copy_characteristics()` (replaced; latest definition is in `20251107100000_calibration_attributes.sql`, nothing later changed it): calls the resolver.
- `app.copy_type_checks_to_gauge(gauge, only_missing)` — shared by the trigger and `POST /gauge-types/{id}/apply-characteristics`, so the two paths cannot drift (today the API has its own inline `INSERT … SELECT`).
- `app.recalculate_gauge_range_checks(gauge)` — `calibration.manage` at the gauge's site; touches only `follows_range` copies; returns what changed.
- `app.gauge_rules()` (replaced from the `20260467100000` version): the "needs a range and unit" rule on insert and on a change of type.
- `app.gauge_characteristic_rules()`: editing nominal, tolerance or unit of a copy sets `follows_range` to false and clears `derivation`.
- `app.calibration_reading_rules()`: copy the two descriptive columns. **Before replacing it, read the latest migration that defines it (including `20260124100000_calibration_integrity.sql`) and use a marker-guarded text patch (`pg_temp.patch_once`), as the repository's rule for shared functions says.**

Everything is audited by the existing triggers. The migration is reversible (drop the new columns, restore the old CHECK and the replaced functions).

## 5. API (`api/src/calibration/`)

- Type characteristic create/update bodies take `nominalBasis`, `toleranceBasis`, `toleranceReadingPercent`, `toleranceSource`; responses carry them and the words for the basis. Validation mirrors the CHECKs (percent 0 to 100, at most three decimals for a point, symmetric bases, unit forbidden for a percent point).
- Gauge responses: characteristics carry `followsRange`, `derivation`, `toleranceSource` and `staleFromRange` (the range now would give different values from the stored ones; worked out by the resolver).
- Gauge types carry `rangeCheckCount`; the apply result adds `gaugesNeedRange`.
- `POST /gauge-types/{id}/preview-points {rangeMin, rangeMax, unitCode, resolution?}` → the resolved list with each derivation and any problem (`calibration.read`; saves nothing).
- `POST /gauges/{id}/recalculate-range-checks` (`calibration.manage`; answers the gauge).
- The apply route calls `app.apply_type_checks(type)` instead of its inline insert. It answers `{ gaugesUpdated, checksAdded, gaugesSkipped, gaugesWithProblems, problems[{gaugeId, assetNumber, checkId, name, problem}] }` (the problem is not always a missing range: a tolerance that works out to nothing or a unit that differs is reported the same way), so the API result gains `gaugesWithProblems` and `problems` rather than a `gaugesNeedRange` count. `gauges_missing_checks` on the type list also has to count gauges that lack a range-based check.
- Calibration readings carry `derivation` and `toleranceSource`.

## 6. Screens

- **Settings → Data Management → Calibration → a type's characteristics** (`CharacteristicsEditor.jsx`):
  - A **point** choice, "A fixed value" or "A % of the gauge's range" (decimals allowed); the unit field is replaced by "uses the gauge's unit" for a percent point.
  - A **tolerance** choice with four options (a fixed value, a % of the span, a % of the reading, a fixed value plus a % of the reading), each showing only the fields it needs and an example sentence ("±(0.003 mm + 0.01 % of the reading) — at 50 mm that is ±0.008 mm").
  - An optional **Where the limit comes from** box.
  - The list reads "50 % of range, ±1 % of span".
  - **Add evenly spaced points** (for example 5 points from 0 to 100 %) creates the checks in one go.
  - **Try it with a range** shows the resolved values, derivations and any problem.
- **Gauge form**: when the chosen type needs a range, Range min, Range max and Unit are required (red `*`, with a hint saying why) and a live preview lists the checks the gauge will get.
- **Gauge page**: range-based checks are marked "from range" with their derivation in words; a notice with **Recalculate range-based checks** appears when `staleFromRange`; editing one says it becomes a fixed check.
- **Calibration record**: the limit's derivation and source appear beside each reading's limits.
- The apply-checks dialog and its notices say how many gauges need a range.
- Help guide `site/src/content/docs/calibration.md` and the `CLAUDE.md` calibration entry are updated with the change (the repository's rule).

## 7. Tests

- `supabase/tests/gauge_type_range_checks.test.sql`:
  - Point arithmetic at 0 %, 100 % and in between, including a decimal percentage and a negative or offset range (−10…+10, 50…100).
  - Rounding to resolution and to four places.
  - Each tolerance basis, including the worked ±(3 + 0.1·L) example at 5 mm and 50 mm.
  - A tolerance that works out to nothing refused (a 0 % point on a 0-based range with a "% of reading" tolerance).
  - The gauge's unit used for a percent point.
  - A gauge with no range refused when the type needs one, and not refused when only a "% of reading" tolerance is used on fixed points.
  - `follows_range` cleared and `derivation` emptied by a manual edit.
  - Recalculation touching only following checks and leaving past readings alone.
  - Apply for existing gauges counting those without a range.
  - The source note and derivation reaching the gauge check and the recorded reading.
  - Fixed and attribute checks completely unchanged.
  - **Deliberate breaks tried:** rounding, the missing-range rule, the follows flag, the resolver ignoring the gauge's unit, the "% of reading" arithmetic, copying the source onto readings.
- `api/test/calibration.e2e-spec.ts`: preview, creation refused without a range, apply counts, recalculation, the body checks for every basis.
- `Calibration.test.jsx`: editor choices and example sentences, evenly spaced points, form requirements and preview, recalculate notice, derivation on the record.
- The existing journey needs no change (its gauge types use fixed checks).

## 8. Slices

| Slice | Content |
|---|---|
| RC1 | **Built.** Migration `20260468100000_gauge_range_checks.sql` + `supabase/tests/gauge_range_checks.test.sql` (columns, resolver, copy, `app.apply_type_checks`, recalculation and state, preview, rules, readings; nine deliberate breaks tried and caught; full SQL suite 210 passing). Not applied live. |
| RC2 | API routes and bodies + e2e + sweep entries for the two new routes — **built** (`POST /gauge-types/{id}/preview-points`, `POST /gauges/{id}/recalculate-range-checks`; type bodies take `nominalBasis`, `toleranceBasis`, `toleranceReadingPercent`, `toleranceSource`; gauge checks carry `followsRange`, `derivation`, `staleFromRange`, `rangeProblem`; types carry `rangeCheckCount`; readings carry `derivation` and `toleranceSource`; apply calls `app.apply_type_checks`) |
| RC3 | Screens, preview, helper, tests; help guide and `CLAUDE.md` — **built** |
| RCX | Full checks, then apply live **only on the owner's go** (history row), live guardrails and advisors, commit |

Nothing is pushed until the owner says so. RC1 and RC2 ship together: before RC2, no screen or route could create a range-based check (the bodies do not expose the new columns), so the live database and the old API stay consistent either way; once RC2 is pushed the migration must be live first (gauge reads select the new columns).

## 9. Decisions for the owner (proposed answer first)

- **R1 Tolerance bases:** proposed **all four** (a fixed value, a % of span, a % of reading, a fixed value plus a % of reading). Together they cover micrometers, pressure gauges, torque and force tools and caliper-style formula specs; without the last two the feature fits only half the gauge types.
- **R2 A gauge with no range, on a type that needs one:** proposed **refuse** with a clear message. The alternative (create it with no checks and fill in later) leaves gauges silently uncalibratable.
- **R3 Rounding:** proposed **to the gauge's resolution** for the nominal when it has one, else four decimals; the tolerance to six decimals.
- **R4 Existing gauges when the range or the type changes:** proposed **never automatic**; an explicit Recalculate action that uses the type's current definition. This matches how types work today.
- **R5 Mixed types** (range points, fixed points and pass/fail in one type): proposed **allowed**.
- **R6 "Add evenly spaced points" helper:** proposed **yes** (screen only, no database change).
- **R7 Unit:** proposed that a range-based point **uses the gauge's own unit** (no conversion).
- **R8 Naming:** the person still names each check; the screen suggests "At 50 % of range".
- **R9 Decimal percentages:** proposed **up to three decimals**, so uneven micrometer sequences can be expressed.
- **R10 Tolerance source note:** proposed **optional free text (200 characters), copied to the gauge's check and each recorded reading**, so an auditor can see where a limit came from.
- **R11 Manufacturer and standard figures:** proposed **none shipped**; the organisation enters its own.
- **R12 A tolerance that works out to nothing:** proposed **refuse, naming the check**, with the preview warning before a gauge is created.

## 10. Not in this change

- Measurement uncertainty of the calibration itself, the test uncertainty ratio (often 4:1) and guard-banded accept/reject decision rules (ILAC-G8 style). The tolerance here is the allowed gauge error against the reference at that point; the uncertainty of the reference and the method stay in the calibration procedure.
- Tolerances written as a formula with any other shape (for example a different slope in each part of the range); a type can hold one check per segment instead.
- A range that depends on the gauge's size in a way other than a straight line (for example logarithmic points).
- Pulling a type's later edits into gauges that already have copies automatically.
- Importing characteristics (still not importable); a gauge imported with its range does get its points from the type through the same trigger.
- Reading the range from the gauge's model name.
