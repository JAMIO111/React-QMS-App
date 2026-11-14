# CMM and measurement file ingestion — plan

**Status:** agreed 2026-11-14 (C1–C15 as recommended; sample files for CM0 still to come) · **CM1 done** (migration `20260226100000_measurement_imports.sql`, not yet applied live) · **Date:** 2026-11-14 · **Brief:** `docs/design-brief.md` §6.4 (inspection and measurement), §12 Phase 6 ("CMM/inspection data ingestion"), §14 (definition of done)

## 1. Why

Today every reading in an inspection is typed in by hand: the inspector reads the value from a screen or a printout and types it in. A CMM (coordinate measuring machine) measures dozens of features per part and already prints or saves them, so typing them in is slow and causes mistakes (transposed digits, wrong row). Most manufacturers our customers are like run at least one CMM, often with other gauge software that writes the same kind of report (vision systems, height gauges, surface testers).

The goal: **the inspector drops the machine's report file onto the running inspection, checks what Fortress matched, and saves. The readings are then exactly like typed ones**: pass/fail worked out by the database, the gauge's calibration state copied, SPC charts and alerts, failures that must be acknowledged or raised as an NC before the inspection completes.

## 2. What exists today (and what we reuse)

| Piece | State | Use |
|---|---|---|
| `inspection_records` / `inspection_samples` / `inspection_measurements` | A sample = one unit measured; a measurement = one reading of one frozen requirement; insert-only, corrections with `supersedes_id` + reason, retests with `retest_of_id`; gauge state copied; result worked out by `app.inspection_measurement_rules` | Imported readings go into these tables unchanged in meaning |
| `resolved_inspection_requirements` | Frozen when the inspection starts: `characteristic_key`, **`char_number` (balloon number on the drawing)**, name, operation, data type, nominal, limits, unit | What a file's features are matched to; **Fortress's limits always decide pass/fail** |
| `InspectionService.addSample` | One sample and its readings in one transaction, then `SpcService.raiseAlerts` | An import applies through the same path (one call per unit in the file), so SPC alerts, sampling plan and subgroups behave the same |
| Gauges (calibration register) | Asset number, status, next due; using an out-of-date gauge needs `inspection.override_gauge` + a reason | The CMM is a gauge; an import names it once for all its readings |
| `api/src/integrations/core/file-parsers.ts` | Reads CSV (works out the encoding and separator) and `.xlsx` | Reused to read table-style reports |
| Job hub (`/Jobs/:id`) and the inspection page | Where readings are recorded | Where the import button lives |
| Integration engine (IN2–IN8) | Syncs master and order data into canonical records | **Not used for readings** (see C2): a reading belongs to a running inspection and needs a person to check it, not a background sync |

## 3. What the files look like

| Format | Who writes it | Shape | Notes |
|---|---|---|---|
| **Table export (CSV / TXT / XLSX)** | Almost every CMM and gauge program can export one: ZEISS CALYPSO "table file" (`*_chr.txt`, tab separated), Hexagon PC-DMIS CSV/Excel export, Mitutoyo MCOSMOS CSV, vision systems | One row per feature (sometimes per feature *and* axis): feature id / name, actual, nominal, upper and lower tolerance (or limits), deviation, sometimes a pass/fail column; a few header lines with part number, serial, program, operator, date | Column names differ by program and by how the customer set up the export. **Handled by a saved "format profile"** that says which column is which |
| **QIF Results** (ISO 23952, XML) | Newer versions of the main CMM programs, metrology software | Structured: part, measured features, characteristics with nominal / tolerance / actual, linked to a QIF plan | Open standard, unambiguous; read without a profile |
| **Q-DAS DFQ / AQDEF** | Automotive suppliers (customer requirement) | Key-value text (`K0001`, `K2001` …) | Later, if a customer asks for it |
| **DMIS output (`.dmo`)** | Older CMM programs | A measuring language, not a report | Not planned: hard to read reliably; nearly every program that writes DMIS can also export a table |
| PDF report | Every program | Printed report | Not read (no reliable parsing). Can be attached to the inspection as evidence |

Column names and file layouts above are from vendor documentation and should be **checked against real files from a customer** (CM0) before the parsers are written.

## 4. Decisions to agree

| # | Question | Options | Recommendation |
|---|---|---|---|
| **C1** | **Which formats first** | (a) table exports through a format profile; (b) also QIF Results; (c) also Q-DAS DFQ | **(a) in the first release, (b) next (CM5), (c) when a customer needs it.** Table exports cover nearly every machine, and a profile lets a customer set up a new program without a code change. Ready-made profiles for CALYPSO table files and PC-DMIS CSV are included, to be copied and adjusted |
| **C2** | **How a file arrives** | (a) a person uploads it on the running inspection or job; (b) a watched folder on the CMM PC, sent by the Phase 6 on-site agent; (c) a machine posts to an API with its own token; (d) an email inbox | **(a) now.** It needs nothing installed and a person checks each file. (b) comes with the agent (connectors plan §14), (c) after it, both ending in the same *import → preview → apply* step. (d) never |
| **C3** | **Which inspection a file belongs to** | (a) the person picks it (they upload *on* the inspection or job); (b) Fortress finds it from the file's part number, work order or serial | **(a).** The file's header is still read and **checked**: a part number that differs from the inspection's part blocks the import; a different work order or lot is a warning to confirm; the serial fills the sample's unit reference. (b) arrives with the watched folder, as a suggestion that a person confirms |
| **C4** | **How a feature finds its characteristic** | (a) by balloon number (`char_number`); (b) by a saved **feature map** per part (CMM feature name → characteristic); (c) by name | **(a) then (b), never (c) alone.** Most CMM programs are written with the drawing's balloon numbers as feature ids. Where they are not, the person matches the features once in the preview and saves it as the part's feature map, used again for every later file of that part. A feature map names a `characteristic_key`, so it survives new control plan revisions. Features in the file that match nothing are listed and left out. Characteristics the file does not cover stay open to measure by hand |
| **C5** | **When the file's nominal or tolerance differs from Fortress's** | (a) ignore it; (b) warn; (c) block | **(b), with a confirmation.** Fortress's frozen limits decide pass/fail (one truth; the file cannot loosen a tolerance). A difference usually means the wrong CMM program or an old drawing revision, so each mismatching feature is shown in the preview, and importing needs the person to tick "I have checked these differences". This is recorded on the import |
| **C6** | **One file = one part?** | (a) one file is one unit measured (one sample); (b) a file may hold several parts (pallet, cavities) | **Both.** By default one file is one sample. A profile can say how to split a file into units: a serial or part-index column, or repeating blocks. Each unit becomes its own sample, in file order, and they go through the sampling plan like typed samples |
| **C7** | **Units (mm / inch)** | — | A value is read in the unit the profile or file declares and converted with the fixed conversions the import steps already use (mm/cm/m/in/ft). With no unit declared, the characteristic's unit is assumed, and the preview shows it |
| **C8** | **Which gauge** | — | The CMM is a gauge in the calibration register. A profile names a default gauge; the person can change it per import. Its state is copied onto every reading exactly as for typed ones; an out-of-date CMM needs `inspection.override_gauge` and a reason, given once for the whole import |
| **C9** | **What is kept** | — | The original file (private bucket `inspection-files`, `<org>/inspection/<record id>/<uuid>-<name>`), an **import record** (who, when, file name, SHA-256, profile and version, gauge, header values, matches, warnings, what was confirmed), and on every reading `import_id` so a reading says where it came from. Nothing is deleted |
| **C10** | **Preview and apply** | (a) save straight away; (b) always preview first | **(b).** Uploading parses and matches the file and saves the import as *previewed* (no readings yet). The preview shows each feature: matched characteristic, value as read, value after unit conversion, limits, the result it will get, mismatches. **Apply** writes the readings through the `addSample` path in one transaction (all or nothing). **Discard** keeps the import record and file for the audit trail. A preview older than a day, or one whose inspection moved on (completed, abandoned), cannot be applied |
| **C11** | **The same file twice / re-measuring** | — | The same file (same SHA-256) applied once on an inspection is refused the second time. A new file for a unit already measured is a **retest** of the failed readings (the person chooses, like the Retest button) or a **correction** (needs `inspection.correct` and a reason). Never a silent overwrite |
| **C12** | **Failures** | — | Exactly as typed readings: shown as failures, must be acknowledged or linked to an NC before the inspection completes, SPC alerts raised. **An import never raises an NC by itself** (the inspection module's "prompts only, never silent" rule) |
| **C13** | **Pass/fail and counts in files** | — | A profile can map a text column to pass/fail for attribute characteristics (e.g. `OK` / `NOK`, `IN` / `OUT`). Defect counts are not expected from CMMs; supported only if a profile names an integer column for a count characteristic |
| **C14** | **Permissions** | — | Importing needs `inspection.record` at the inspection's site (as typing readings does); format profiles and feature maps are managed with `process_control.manage`; anyone recording can save a new feature map from the preview (it records who). No new permission, no subscription feature |
| **C15** | **Incoming inspection** | — | An incoming inspection (`trigger = incoming`) is the same kind of record, so the import works there too, with no extra work. A supplier's own measurement report attached to a delivery is a **different** thing (evidence, not our readings) and stays a material certificate / document |

## 5. Data model (sketch; tenant tables, RLS, audit trigger, no deletes)

```
measurement_import_profiles   id, organisation_id, name, format (table|qif), version, settings jsonb (encoding, separator, header rows,
                              columns: feature, actual, nominal, upper/lower tolerance or limits, unit, pass/fail, serial/unit split,
                              header fields: part number, serial, work order, operator, measured at), default gauge_id,
                              active, retired reason                       -- versions frozen; saved by functions; process_control.manage
measurement_feature_maps      id, organisation_id, part_id, profile_id?, feature_name, characteristic_key, created_by, ended_at
                              -- unique live (part, profile, feature name ignoring case); ended, never deleted
inspection_imports            id, organisation_id, inspection_record_id, reference (IMP-YY-NNNN), status previewed|applying|applied|discarded (a preview over a day old is refused, worked out),
                              file_path, file_name, file_sha256, size, profile_id + version, gauge_id, gauge_override_reason,
                              header jsonb, summary jsonb (features read, matched, unmatched, failures, mismatches), warnings jsonb,
                              mismatches_confirmed_at/by, applied_at/by, discarded reason, created_at/by
inspection_import_units       id, import_id, position, unit_reference, sample_id (after apply)
inspection_import_rows        id, import_id, unit_id, feature_name, char_number_read, raw jsonb, value_numeric/pass, unit_read,
                              requirement_id?, match_kind balloon|map|manual|none, file_nominal/limits, mismatch, result_expected,
                              measurement_id (after apply)
inspection_measurements       + import_id (composite FK, null for typed readings)
```

All writes go through SECURITY DEFINER functions (`app.create_inspection_import`, `app.set_import_row_match`, `app.confirm_import_mismatches`, `app.apply_inspection_import`, `app.discard_inspection_import`, `app.save_measurement_profile`, `app.save_feature_map`), which check `inspection.record` at the site. **Applying inserts the samples and measurements as the person**, so every existing trigger and rule (pass/fail, gauge state, sampling, subgroups, one live NC per reading) runs unchanged. Errors use the existing `QM008` → `409 inspection_rule`.

## 6. API and screens (sketch)

- `api/src/inspection/imports/`: `parsers/table.ts` (profile-driven), `parsers/qif.ts` (CM5), `match.ts` (balloon → feature map → none; units; mismatch), all pure and unit-tested with real sample files.
- `POST /inspections/{id}/imports {path, fileName, size, profileId, gaugeId?}` (parse + match → preview), `GET /inspection-imports/{id}`, `PUT …/rows/{rowId}/match {requirementId|null, remember}`, `POST …/confirm-mismatches`, `POST …/apply {gaugeOverrideReason?, mode: new|retest|correct, reason?}`, `POST …/discard {reason}`; `GET /inspections/{id}/imports`; `GET|POST /measurement-profiles`, `PATCH …/{id}`, `POST …/{id}/test {path}` (try a file against a profile, nothing saved); `GET|POST /parts/{id}/feature-maps`.
- **Inspection page and job hub:** an **Import from CMM** button (drop zone; profile and gauge remembered per machine on this browser), then the **preview**: header checks at the top (part, work order, serial), one row per feature (balloon, feature name, characteristic combo, value, limits, result as it will be, mismatch flag), unmatched features folded below, "Remember these matches for BRK-1", the mismatch confirmation, **Apply N readings** / Discard. After applying, readings show a small "CMM" marker linking to the import.
- **Settings → Data Management → Process control → Measurement files:** profiles (start from CALYPSO table file or PC-DMIS CSV, or a blank one), with **Try a file**, which shows how the profile reads it; feature maps per part on the part page.

## 7. Slices

| Slice | Content | Exit |
|---|---|---|
| **CM0** | Agree C1–C15; collect 3–5 real report files (at least CALYPSO and PC-DMIS, one multi-part, one in inches) with their part's drawing balloons | Plan signed off, sample files in `api/test/fixtures/cmm/` (anonymised) |
| **CM1** | Migration: profiles, feature maps, imports, units, rows, `import_id` on measurements, bucket and storage rules, functions; SQL tests, tenancy sweep seeds, guardrails list | Imports can be created, matched, applied and discarded in SQL, with every rule tested |
| **CM2** | Parsers (table via profile, two ready-made profiles), matching, unit conversion, mismatch detection; preview API; unit tests on the real files; e2e | A real file previews with the right matches |
| **CM3** | Apply through the `addSample` path (several units, gauge override, retest and correction modes, duplicate file refused, expired preview refused), SPC alerts, failures; e2e (+ API sweep) | Applied readings are identical in behaviour to typed ones |
| **CM4** | UI: import button and preview on the inspection page and job hub, profiles in Settings with Try a file, feature maps on the part page, CMM marker on readings; component tests | An inspector imports a file without help |
| **CM5** | QIF Results reader (no profile needed) | A QIF file previews and applies |
| **CM6** | Exit check: browser journey step (upload a CMM file on a job, fix one match, confirm a mismatch, apply, a failure acknowledged), live guardrails, advisors, exit report | Brief §14 checklist verified |

## 8. Tests that make it safe

A part-number mismatch blocks; the file's tolerance never decides pass/fail; an unmatched feature writes nothing; applying is all or nothing; the same file twice is refused; an expired or moved-on preview cannot be applied; an out-of-date CMM needs the override permission; a foreign organisation's import, file or profile is refused (404); readings from an import trigger SPC alerts and need acknowledgement like typed ones; hostile files (huge, wrong encoding, formula-looking cells, thousands of features, a column named `__proto__`) are rejected or read safely.

## 9. CM1 as built (migration `20260226100000_measurement_imports.sql`)

- **Tables:** `measurement_import_profiles` (name unique among active ignoring case, `format` table|qif fixed once created, `current_version`, optional `default_gauge_id`, retired with a reason) and `measurement_import_profile_versions` (settings jsonb ≤ 50 kB, reason from version 2, **frozen by trigger even for SQL**); `measurement_feature_maps` (part, optional profile, feature name, `characteristic_key`; one live map per part, profile and feature ignoring case; ended, never deleted or changed); `inspection_imports` (`IMP-YY-NNNN`, status `previewed → applying → applied | discarded`, file path / name / SHA-256 / size, profile and the version used, gauge, header, warnings, mismatch confirmation, apply mode new|retest|correct with reason and gauge override reason; frozen once applied or discarded); `inspection_import_units` (one per part in the file, `sample_id` after applying); `inspection_import_rows` (one per feature: what the file said — feature name, balloon, raw cells, value as text and in the characteristic's unit, the file's nominal and limits — plus the match). `inspection_measurements.import_id` says where a reading came from.
- **The database works out each row** (`app.inspection_import_row_rules`): from the frozen requirement it is matched to, the result it will get (our limits, inclusive, like a reading), a `problem` when the value does not fit the check (a number for a pass/fail check, a check that does not apply) and `mismatch` when the file's nominal or a limit differs from ours by more than 1/1000 of the tolerance band (1/1,000,000 of the value without a band), or the file has a limit we do not.
- **Functions** (SECURITY DEFINER; `inspection.record` at the inspection's site unless noted; another organisation `P0002`; rules `QM008`): `app.save_measurement_profile(org, body, id?)`, `retire_ / reactivate_measurement_profile` (`process_control.manage`); `app.save_feature_map(part, profile?, feature, key)` (records anywhere or `process_control.manage`; a different key ends the old map), `app.end_feature_map(id)` (manager or whoever saved it); `app.create_inspection_import(inspection, body)` (inspection in progress; the file must be in the inspection's folder; **a header part number that is not the inspection's part is refused**; a different work order or lot adds a warning; ≤ 200 parts and 5,000 features; matched checks must be the inspection's); `app.set_inspection_import_match(row, requirement|null)` (one feature per check per part; clears the mismatch confirmation); `app.confirm_inspection_import_mismatches(import)`; `app.discard_inspection_import(import, reason?)`; `app.begin_inspection_import_apply(import, gauge, mode, reason, override)` (refuses a preview over a day old, unconfirmed mismatches, nothing matched, the same file already applied to the inspection; a correction needs a reason and `inspection.correct`; returns the units and rows to record) and `app.finish_inspection_import_apply(import, [{unitId, sampleId}])`.
- **Applying** happens in one transaction: begin marks the import `applying` and sets `app.inspection_import` for the transaction; the API records each part as a sample and each matched row as a reading **through the normal path** (so pass/fail, gauge state and override, sampling, subgroups and SPC alerts all run as for typed readings), each reading carrying `import_id` (`app.inspection_measurement_import_rules` refuses `import_id` at any other time, and a gauge other than the import's); finish checks every matched row became exactly one reading of that check in that part's sample with the same value, as a new reading / retest / correction by mode, that no other reading names the import, then marks it applied. A deferred constraint trigger (`inspection_imports_settled`) refuses to commit an import left `applying`.
- **Storage:** private bucket `inspection-files` (25 MB), `app.inspection_file_allowed`: read with `inspection.read` at the site; upload into `<org>/inspection/<inspection id>/…` only while the inspection is in progress, with `inspection.record`; never updated or deleted.
- **Reading:** imports, units and rows with `inspection.read` at the inspection's site; profiles, versions and feature maps by every member. No table writes for anyone. Imports, profiles, versions and maps are audited; units and rows (many, frozen) are not.
- **Tests:** `supabase/tests/measurement_imports.test.sql`, tenancy sweep seeds and probes, guardrails list.

## 10. Not in this plan

Reading PDFs or DMIS; automatic NCs; a file sent with no person checking it (comes with the agent, C2b, and still ends in a preview unless a customer agrees otherwise); writing CMM programs or plans back to the machine; QIF Plans (making control plans from a CAD model); Q-DAS DFQ (later, on request); statistics on features that are not in the control plan.
