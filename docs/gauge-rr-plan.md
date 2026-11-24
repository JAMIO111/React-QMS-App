# Gauge R&R (measurement system analysis) — plan and decisions

Measurement system analysis (MSA) answers "can this gauge, used by these people, be trusted to measure this characteristic?" Calibration
(`docs/calibration-plan.md`) answers a different question — "is the gauge itself still accurate?" — and its plan lists MSA / gauge R&R as
**not in that slice**. This plan adds it **under the Calibration menu**, as complete vertical slices (brief §2, §14). Nothing here changes how
calibration, inspection or SPC work today.

Status: **planned, nothing built.** Decisions D1–D3 were agreed with the product owner on 2026-11-24; D4–D14 are proposals recorded here so they
can be challenged before any code is written.

## 1. What the module is for

- **Prove a measurement system is capable** for a characteristic before its readings are used for SPC, sorting or release.
- **Keep the evidence** (design, raw data, analysis, verdict, who concluded what) as a frozen, printable record an auditor or customer can ask for
  (IATF 16949 7.1.5.1.1, AS9100 7.1.5, VDA 5).
- **Show where there is no evidence**: critical and major characteristics measured with a gauge that has no current acceptable study.

It is **information only** (D2): a poor result never changes a gauge's status and never blocks recording.

## 2. Decisions

| # | Question | Decision |
|---|----------|----------|
| D1 | Which studies first? | **Agreed:** crossed gauge R&R (ANOVA and average-and-range), the Type 1 study (bias and repeatability, Cg / Cgk) and attribute agreement (kappa, effectiveness, miss and false-alarm rates). Later: linearity and bias, stability, nested (destructive) studies. |
| D2 | What does an unacceptable result do? | **Agreed: information only.** Shown on the study, the gauge page and the control plan characteristic; a workflow rule can notify people. No gauge status change, no quarantine, no blocking, no banner while recording. |
| D3 | How do measurements get in? | **Agreed:** a randomised, appraiser-blind **run sheet grid** (tablet friendly) **and** paste / CSV of a spreadsheet. |
| D4 | Where do appraisers come from? | The **Employees register** (like NC "Detected by": shop-floor people often have no sign-in), or a typed name for someone outside the company. The name is copied onto the study. |
| D5 | Permissions | **No new permission.** Read = `calibration.read`; enter measurements = `calibration.record`; design, complete and cancel = `calibration.manage`. Site-scoped through the gauge, like calibrations. This keeps the package matrix (`every_feature_priced`) untouched. |
| D6 | What is a study about? | One **gauge** plus one **characteristic**. The characteristic is either a control plan characteristic (part + `characteristic_key`, which brings its name, unit and limits) or typed (name, unit, limits). Name, unit, limits and the gauge's resolution are **copied** onto the study so history cannot change. |
| D7 | Where do the statistics run? | **In the API as pure, unit-tested functions** (like `api/src/spc/`), not in SQL: the F-distribution and ANOVA are impractical in plpgsql. The database holds data and rules and **refuses to freeze a result for data it does not hold** (§5). |
| D8 | Study lifecycle | draft → collecting → completed, or cancelled (reason). Analysis is shown live while collecting; **completing** needs a full data set and a written conclusion, then everything is **frozen**. A repeat is a new study (`repeat_of`). |
| D9 | Acceptance criteria | Fixed defaults in code in v1, **recorded inside every frozen result** (name and version of the criteria used), so making them configurable later cannot rewrite history. Gauge R&R: %study variation or %tolerance under 10% acceptable, 10–30% marginal, over 30% unacceptable, ndc ≥ 5 (the AIAG MSA 4th edition bands). Cg / Cgk ≥ 1.33. Attribute bands from the same source, **to be checked against the source text when built**. |
| D10 | Validity | A completed study is valid for **12 months** (editable per study at completion). Expiry is **worked out on read** (valid / expiring in 60 days / expired); it never changes anything, as for supplier certificates. |
| D11 | Files on a study | **Not in v1.** The printable report is the evidence; a signed paper run sheet attachment is the likely first request afterwards. |
| D12 | Study variation multiplier | **6σ** (99.73%) by default, with 5.15σ (99%, older AIAG) as a per-study choice. Recorded in the result. |
| D13 | Missing cells | The ANOVA method needs a **balanced, complete** design, so a study cannot be completed with an empty cell. Cells can be left empty while collecting. |
| D14 | One-sided tolerances | %tolerance needs both limits. With one limit only %study variation is judged and the result says why. |

## 3. The studies

**Crossed gauge R&R (variable data).** `p` parts × `k` appraisers × `r` trials, every appraiser measures every part `r` times in a random
order without seeing earlier readings. Guidance 10 × 3 × 3, smaller designs allowed with a warning (never fewer than 2 of each).
- **ANOVA method (the headline):** two-way ANOVA with interaction, F-test of part × appraiser (significance 0.05 by default, 0.25 selectable
  as AIAG used; if not significant it is pooled into repeatability), variance components → repeatability (equipment variation),
  reproducibility (appraiser variation, with the interaction shown), total gauge R&R, part-to-part, total variation; %contribution,
  %study variation, %tolerance, number of distinct categories (ndc = ⌊1.41 × σ_part / σ_GRR⌋).
- **Average-and-range method** (shown beside it when the design fits the published K1 / K2 / K3 tables: up to 3 appraisers, and the trials and
  parts the tables cover; otherwise the page says it does not apply).
- **Charts** (each also given as a table): range chart and average chart by appraiser, readings by part, readings by appraiser, part × appraiser
  interaction lines, components of variation. Colours from the `--chart-*` variables.
- **Checks and warnings:** resolution against tolerance and process spread, fewer than the guided parts / appraisers / trials, parts that do not
  span the process (part variation small against tolerance), very few distinct readings, outliers (an appraiser's range above the limit).

**Type 1 study (bias and repeatability).** One reference part with a known reference value (from a certificate or master), measured `n`
times (25 minimum recommended, 50 typical) by one appraiser with the same gauge. Output: mean, bias, standard deviation, a t-test of the bias,
Cg = (0.2 × T) / (6 s) and Cgk = (0.1 × T − |bias|) / (3 s) (K = 20% and L = 6 by default, both recorded), resolution as a share of tolerance,
a run chart of readings against the reference. Needs both limits for Cg / Cgk.

**Attribute agreement.** `n` samples (30–50 recommended) each with a **known reference decision** (accept / reject), `k` appraisers, `r` trials.
Output: agreement within each appraiser, each appraiser against the reference (with Cohen's kappa), between appraisers (Fleiss' kappa),
all appraisers against the reference, **effectiveness**, **miss rate** (a bad part accepted) and **false-alarm rate** (a good part rejected),
and the confusion counts behind each. Binary decisions only in v1 (more than two categories is a later extension).

All formulas, constants and criteria are written next to the code with their source, and the exact expected numbers come from the source
datasets, **not from memory** (§7).

## 4. Data model (one migration, `supabase/migrations/2026…_gauge_rr.sql`)

All new tables carry `organisation_id`, composite foreign keys to the same organisation, RLS (site-scoped through the gauge), the
`audit_changes` trigger, no deletes, and are added to the guardrails list and both sweeps.

- `msa_studies` — `MSA-YY-NNNN` (`app.msa_study_counters`, `app.pad_number`); `study_type` `grr_crossed | type1 | attribute`; `gauge_id`;
  subject: optional `part_id`, `characteristic_key`, `operation_code`, plus the copied `characteristic_name`, `unit_code`, `nominal`,
  `lower_limit`, `upper_limit`, `gauge_resolution`; design `part_count`, `appraiser_count`, `trial_count`; analysis options
  (`sigma_multiplier`, interaction significance, Type 1 `reference_value`, `K`, `L`); `status`; `started_at`; `completed_at/by`;
  `conclusion` (accepted | accepted with conditions | not accepted) and `conclusion_note`; `valid_until`; `repeat_of_id`; cancel reason.
  The design is editable only while draft.
- `msa_study_appraisers` — position, `employee_id` (optional) and the copied name.
- `msa_study_parts` — position, label (what the appraiser sees), and for Type 1 / attribute the reference value or reference decision.
- `msa_study_measurements` — study, appraiser, part, trial, `run_order` (generated), `value` numeric as entered **or** `decision`,
  `entered_by/at`, `source` grid | paste. One live row per (study, appraiser, part, trial). Editable and audited while collecting, frozen on completion.
- `msa_study_results` — one frozen row per completed study: the full result as jsonb, the `algorithm_version`, the criteria used, and a
  `data_hash` of the measurements it was worked out from.

**Writes are functions only** (the supplier and competence pattern), `QM034` → `409 msa_rule`, another organisation's id `P0002` → 404:
`app.create_msa_study`, `update_msa_design` (draft), `start_msa_collection` (checks the design, generates the random run order from a hash of
the study id so it is repeatable, locks the design), `record_msa_measurements(study, jsonb)` (the grid and the paste both land here; checks
parts / appraisers / trials exist, values finite, collecting only), `cancel_msa_study(reason)`, `repeat_msa_study`, and the **API-login-only**
`app.system_complete_msa_study(org, study, person, conclusion, note, valid_until, result, data_hash)`.

**Completion rules (database).** The person still holds `calibration.manage` at the gauge's site (re-checked as that person, the same way the
other `system_*` functions act for a requester); the study is `collecting`; every cell is filled; `data_hash` equals the hash the database
works out from the measurements it holds (so a result cannot be frozen for different data); then the study is `completed`, measurements and
design are frozen by trigger (even for SQL) and the outbox event `msa.study.completed` is written.

**Derived, never stored:** the current study per gauge and characteristic (latest completed, not repeated by a newer one), its validity state,
and coverage (§6).

## 5. API (`api/src/msa/`, routes under `/msa`)

- `GET|POST /msa/studies` (page-based: `q`, `status`, `type`, `gaugeId`, `partId`, `verdict`, `valid` (valid | expiring | expired), `sort`, paging),
  `GET|PATCH /msa/studies/{id}` (`@Versioned('msa_studies')`), `PUT /msa/studies/{id}/design`, `POST …/start`, `PUT …/measurements`
  (grid cells or pasted rows), `GET …/analysis` (live, from the stored data), `POST …/complete`, `POST …/cancel`, `POST …/repeat`,
  `GET /msa/studies/{id}/report` (the frozen result for a completed study).
- `POST /msa/studies/{id}/measurements/parse` — turns pasted text / CSV into cells **without saving**, with row-level problems (unknown part or
  appraiser, not a number), the way the import preview does.
- `GET /msa/coverage` (§6) and `GET /gauges/{id}/msa` (the gauge page card).
- `complete` computes the result **in the API from the data in the database** (never from numbers sent by the browser), then calls the
  API-login function. An e2e test recomputes every frozen result from its frozen data and requires an exact match.
- Statistics are pure functions in `api/src/msa/` — `anova.ts`, `range-method.ts`, `type1.ts`, `attribute.ts`, `distributions.ts` (regularised
  incomplete beta and gamma, hence F and t probabilities, written here with no new dependency) and `criteria.ts`.

## 6. Where it appears

- **Menu:** Calibration → Dashboard, Gauges, **Gauge R&R** (`/Calibration/Gauge-RR`). The page has a `SlidingToggle`: **Studies** (the usual
  register: `TableWrapper`, column menu, filter drawer, chips, CSV, saved filters later) and **Coverage**.
- **Study page** `/Calibration/Gauge-RR/:id` (`new` creates): design, the run sheet (grid with a progress count; only the appraiser's own
  readings are shown for the cell being entered), paste / CSV with the parse preview, live analysis with the charts and plain-words
  verdict, **Complete** (conclusion, note, validity), Cancel, **Repeat study**. A completed study is read-only and shows its frozen result.
- **Report** `/Calibration/Gauge-RR/:id/report` (like the 8D and management review reports): design, data, ANOVA table, components of
  variation, charts, verdict and conclusion, who and when; "Print or save as PDF" prints only the report.
- **Gauge page:** a **Measurement system studies** card (current study per characteristic with %GRR, verdict and valid-until, **Start a study**).
- **Control plan characteristic** (plan revision page): a small badge from the same lookup — the latest study of that
  `characteristic_key` for the gauges recorded against it, or "no study".
- **Coverage:** every characteristic on an effective control plan revision with criticality **critical or major**, against each gauge that
  recorded readings for it in the last 12 months (`inspection_measurements.gauge_id`; none yet is shown as "no readings"), with one of
  *no study / expired / not accepted / marginal / acceptable*. Information only, links to the study or **Start a study** prefilled.
- **Events:** `msa.study.completed` in the outbox; a workflow trigger "Gauge R&R study completed" (facts: verdict, %GRR, gauge, characteristic) and a
  reminders area for expiring studies come in the last slice.

## 7. How the statistics will be verified (before any screen is built)

The maths is the risk, so it is built and proved **first** (slice MS1) with no database or screen:
1. **Published datasets:** the AIAG MSA 4th edition worked examples (crossed R&R, and the attribute small-sample study) and Minitab's documented
   sample studies, with their published component values, %values and ndc. The expected numbers are copied from the sources when the
   test is written; if a source cannot be obtained, that dataset is **not claimed as verified**.
2. **An independent implementation:** the same generated data run through a separate tool (a two-way ANOVA in Python / R if one can be
   installed in the build environment — neither scipy nor R is installed in this container today) and compared to a stated tolerance, plus
   closed-form checks (balanced designs with no appraiser or interaction effect, perfect agreement and perfect disagreement for kappa).
3. **Edge cases:** negative variance estimates clamp to zero (and say so), identical readings, two parts, an appraiser who disagrees with
   everyone, ties in ndc rounding.
The test names the source of every expected value, and the report prints the algorithm version so a result can always be traced to the
code that made it.

## 8. Slices

| Slice | Content | Exit |
|-------|---------|------|
| **MS1** | The statistics library and its proofs (§7). No database, no screens. | Unit tests pass against the published datasets and the independent check; formulas and sources documented in the code. |
| **MS2** | Migration and SQL tests: tables, rules, run-order generation, completion function, frozen triggers, RLS, audit, outbox event, guardrails and tenancy-sweep seeds. | `npm run db:check` green; mutants (a broken freeze, a wrong site check, a stale hash) are caught. |
| **MS3** | API: routes above, paste parsing, completion, analysis, report; e2e (frozen result equals recompute, permissions, tenant isolation) and the API sweep. | `api:test` and `api:test:e2e` green. |
| **MS4** | Screens: register, study page with run sheet and paste, live analysis and charts, report, gauge card, menu, hooks, `refreshOrganisation`, optimistic cell entry, tests. | Lint, tests and build green; browser check of the run sheet on a narrow screen. |
| **MS5** | Coverage page, control plan characteristic badge, validity, workflow trigger and notice, reminders area. | As above; `workflows.e2e` catalogue test updated. |
| **MS6** | Live guardrails and advisors, journey step (design → run sheet → paste → complete → report → coverage), exit report, `CLAUDE.md`. | Exit report `docs/gauge-rr-exit-report.md`. |

## 9. Not in this plan

Linearity and bias, stability and nested studies; more than two attribute categories; uncertainty budgets; configurable acceptance criteria
per organisation; files on a study; scheduled studies and automatic reminders beyond expiry; blocking or warning while recording (D2);
linking a study to a gauge **type** (v1 studies a specific gauge); measurement data pulled from a CMM import (the paste path covers it).

## 10. Risks

- **Numerical correctness** — mitigated by building and proving MS1 first (§7).
- **Small or unbalanced designs** — refused or warned, never silently analysed (D13).
- **Over-trusting a pass** — every verdict states its basis (%study variation, %tolerance, ndc) and its limits; a study is for one characteristic
  and gauge, so coverage never claims more than the study covered.
- **Randomisation expectations** — the run order is repeatable and recorded, but it is a record of the intended order; the appraiser-blind
  discipline on the shop floor is still the person's.
