# Gauge type check points as a percentage of the gauge's range

Status: **plan, nothing built** (2026-11-28). Decisions R1–R8 below are proposed; they become agreed when the owner answers §9.
Builds on `docs/calibration-plan.md`. Read that first for the tables named here.

## 1. The problem

A gauge type is a template: a code, a default interval, a procedure document and a list of **checks** (`gauge_type_characteristics`).
When a gauge is created, the database copies the type's active checks onto the gauge (`app.gauge_copy_characteristics`), and from then on the gauge owns its copies.

Each template check has a **fixed nominal** (for example 25.000 mm ± 0.004). That is fine for a type that is already specific ("External micrometer 0–25 mm"), but:

- A general type ("External micrometer") cannot work: a 0–25 mm and a 75–100 mm micrometer need different check points, and the type cannot say so.
- The only ways round it today are one type per range (many types) or editing every gauge's checks by hand after creating it (slow, easy to get wrong, inconsistent between gauges).

Calibration labs usually define check points **across the gauge's range**: for example 0, 25, 50, 75 and 100 % of the range for a micrometer, a pressure gauge or a torque wrench, with a tolerance that is either a fixed value or a percentage of full scale (span).

## 2. What we want

A type can say, per check: *"place this point at X % of the gauge's own range"* and, optionally, *"the tolerance is Y % of the span"*. Each gauge then gets its own real values worked out from **its** range when it is created. Nothing else about calibration changes: a gauge still owns its copies, a reading still copies its limits from the gauge's check at the moment it is recorded, and past readings never move.

Mixed types stay possible: the same type can hold range-based points, fixed points and pass/fail (attribute) checks.

## 3. How it behaves

| Question | Behaviour |
|---|---|
| Existing types and gauges | **Unchanged.** Every existing check is a fixed point. No backfill. |
| A range-based check on the type | Stored as a percentage (0–100) of the range, plus a tolerance that is either an absolute value (as today) or a percentage of the span. |
| Gauge created from such a type | The database works out nominal and tolerance from the gauge's `range_min` / `range_max`, **in the gauge's unit**, and stores ordinary values on the gauge's check (so every report, reading and import that reads a gauge check works without knowing about ranges). |
| The arithmetic | **nominal = range_min + (percent ÷ 100) × (range_max − range_min)**, so 0 % is the range minimum (not zero) and 100 % is the range maximum: on a 50–100 mm gauge the points 0, 25, 50, 75, 100 % are 50, 62.5, 75, 87.5, 100. **Span = range_max − range_min**, so a tolerance of ±1 % of span on that gauge is ±0.5 mm. The range must have range_max above range_min. |
| Rounding | The nominal is rounded to the gauge's **resolution** when it has one (a point the gauge can actually show), otherwise to four decimal places. |
| Gauge with no range, type has range checks | Creating or retyping it is **refused** with a plain message ("This type places its checks across the gauge's range: enter the range and unit"), the same way a missing gauge type is refused. Gauges from before this rule are never blocked from other edits. |
| Range changed later | The gauge's checks **do not change by themselves**. The gauge page shows a notice and a **Recalculate range-based checks** action (needs `calibration.manage`). Past readings keep the limits they were recorded with. |
| A person edits a range-based check on one gauge | It becomes an ordinary fixed point on that gauge (it stops following the range). The gauge page says so. |
| Type edited afterwards | As today, **nothing propagates**. "Apply the checks to them" adds missing checks to existing gauges; it now also works out range-based ones, and counts the gauges that could not be given one because they have no range. |
| Preview | The type page and the gauge form can show "what these points become for a 50–100 mm gauge" before saving. The answer comes from the database, nothing is saved. |

## 4. Data model (one migration, additive)

`gauge_type_characteristics` (the template) gains:

- `nominal_basis text NOT NULL DEFAULT 'value' CHECK (nominal_basis IN ('value', 'span_percent'))` — when `span_percent`, `nominal` holds the percentage (0–100) and `unit_code` is NULL (the gauge's unit is used).
- `tolerance_basis text NOT NULL DEFAULT 'value' CHECK (tolerance_basis IN ('value', 'span_percent'))` — when `span_percent`, `tolerance_minus` / `tolerance_plus` hold percentages of the span (0–100).
- The `kind_fields` CHECK is rewritten: a variable check needs a nominal, both tolerances, and a unit **unless** its nominal is a percentage of span; an attribute check still has none of them.

`gauge_characteristics` (the gauge's copy) gains:

- `follows_range boolean NOT NULL DEFAULT false` — true only for a copy that was worked out from a range-based template check and has not been edited by hand. Values stay ordinary: `nominal`, `tolerance_*`, `unit_code` are always filled for a variable check, so nothing downstream changes.

No change to `calibration_readings`, `calibrations`, imports of gauges (`rangeMin`, `rangeMax` and `unitCode` are already importable), reporting views, PPAP or Gauge R&R.

Functions (all `SECURITY DEFINER`, fixed `search_path`, `QM006` → `409 calibration_rule`):

- `app.resolve_type_check(template_id, range_min, range_max, unit, resolution)` → `{nominal, toleranceMinus, tolerancePlus, unit}` — the one place the arithmetic lives. Pure; used by the trigger, the apply route, the recalculation and the preview.
- `app.gauge_copy_characteristics()` (replaced; latest definition is in `20251107100000_calibration_attributes.sql`, nothing later changed it): calls the resolver for range-based checks.
- `app.copy_type_checks_to_gauge(gauge, only_missing)` — shared by the trigger and `POST /gauge-types/{id}/apply-characteristics`, so the two paths cannot drift (today the API has its own inline `INSERT … SELECT`).
- `app.recalculate_gauge_range_checks(gauge)` — `calibration.manage` at the gauge's site; touches only `follows_range` copies; returns what changed.
- `app.gauge_rules()` (replaced from the 20260467100000 version): the "needs a range and unit" rule on insert and on a change of type.
- `app.gauge_characteristic_rules()`: editing nominal, tolerance or unit of a `follows_range` copy sets it to false.

Everything is audited by the existing triggers. The migration is reversible (drop the new columns, restore the old CHECK and the two functions).

## 5. API (`api/src/calibration/`)

- Type characteristic create/update bodies take `nominalBasis`, `toleranceBasis`; responses carry them. Validation mirrors the CHECKs (percent 0–100, unit forbidden for a percent nominal).
- Gauge responses: characteristics carry `followsRange` and `staleFromRange` (the range now would give different values than the stored ones; worked out by the resolver).
- Gauge types carry `rangeCheckCount`; apply result adds `gaugesNeedRange`.
- `POST /gauge-types/{id}/preview-points {rangeMin, rangeMax, unitCode, resolution?}` → the resolved list (`calibration.read`; saves nothing).
- `POST /gauges/{id}/recalculate-range-checks` (`calibration.manage`; answers the gauge).
- The apply route calls `app.copy_type_checks_to_gauge` instead of its inline insert.

## 6. Screens

- **Settings → Data Management → Calibration → a type's characteristics** (`CharacteristicsEditor.jsx`): a check point choice, "A fixed value" or "A % of the gauge's range"; the same choice for the tolerance; the unit field is replaced by "uses the gauge's unit" for a percent point; the list reads "50 % of range ± 0.004 mm". A small **Add evenly spaced points** helper (for example 5 points from 0 to 100 %) creates the checks in one go. A **Try it with a range** preview shows the resolved values.
- **Gauge form**: when the chosen type has range-based checks, Range min, Range max and Unit are required (red `*`, with a hint saying why) and a live preview lists the points the gauge will get.
- **Gauge page**: range-based checks are marked "from range"; a notice with **Recalculate range-based checks** appears when `staleFromRange`; editing one says it becomes a fixed point.
- Apply-checks dialog and notices say how many gauges need a range.
- Help guide `site/src/content/docs/calibration.md` and the `CLAUDE.md` calibration entry are updated with the change (the repository's rule).

## 7. Tests

- `supabase/tests/gauge_type_range_checks.test.sql`: arithmetic at 0 %, 100 % and in between; a negative or offset range (−10…+10, 50…100); rounding to resolution and to four places; tolerance as a percentage of span; the gauge's unit used; a gauge with no range refused (and a gauge with no type rule still working); `follows_range` cleared by a manual edit; recalculation touching only following checks and leaving past readings alone; apply for existing gauges counting those without a range; fixed and attribute checks completely unchanged; **deliberate breaks tried** (rounding, the missing-range rule, the follows flag, the resolver ignoring the gauge's unit).
- `api/test/calibration.e2e-spec.ts`: preview, creation refused without a range, apply counts, recalculation, the body checks.
- `Calibration.test.jsx`: editor choice, evenly spaced points, form requirements and preview, recalculate notice.
- The existing journey needs no change (its gauge types use fixed checks).

## 8. Slices

| Slice | Content |
|---|---|
| RC1 | Migration + SQL test (columns, resolver, copy, shared copy function, rules, recalculation) |
| RC2 | API routes and bodies + e2e + sweep entries for the two new routes |
| RC3 | Screens, preview, helper, tests; help guide and `CLAUDE.md` |
| RCX | Full checks, then apply live **only on the owner's go** (history row), live guardrails and advisors, commit |

Nothing is pushed until the owner says so; the API must not be pushed before the migration is live (gauge reads would select the new column).

## 9. Decisions for the owner (proposed answer first)

- **R1 Tolerance as a percentage of span too?** Proposed **yes**. Pressure and torque gauges are normally ±x % of full scale; micrometers are normally a fixed ±value. Without it the feature fits only half the gauge types. Cost: one extra column and a few lines.
- **R2 A gauge with no range, type with range checks:** proposed **refuse** with a clear message. The alternative (create it with no checks and fill in later) leaves gauges silently uncalibratable.
- **R3 Rounding:** proposed **to the gauge's resolution** when it has one, else four decimals.
- **R4 Existing gauges when the range or the type changes:** proposed **never automatic**; an explicit Recalculate action. This matches how types work today.
- **R5 Mixed types** (range points, fixed points and pass/fail in one type): proposed **allowed**.
- **R6 "Add evenly spaced points" helper:** proposed **yes** (screen only, no database change).
- **R7 Unit:** proposed that a range-based check **uses the gauge's own unit** (no conversion between a type in mm and a gauge in inches).
- **R8 Naming:** the person still names each check; the screen suggests "At 50 % of range".

## 10. Not in this change

- A range that depends on the gauge's size in a way other than a straight line (for example logarithmic points).
- Pulling a type's later edits into gauges that already have copies automatically.
- Importing characteristics (still not importable); a gauge imported with its range does get its points from the type through the same trigger.
- Reading the range from the gauge's model name.
