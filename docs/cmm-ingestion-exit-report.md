# CMM and measurement file ingestion — exit report

**Date:** 2026-11-14 · **Plan:** `docs/cmm-ingestion-plan.md` (decisions C1–C15) · **Slices:** CM1–CM6 (CM0, real sample files, still to come) · **Branch:** `Dev`

## What was built

Before this plan an inspector typed every CMM value by hand. Now the CMM's report file is read onto the running inspection or job, checked by a person, and recorded in one go. **A file never becomes a reading on its own:** it is kept as a preview until someone records it. **Recording goes through the same path as typed readings**, so the frozen limits, the database's pass / fail, the gauge's calibration state, the sampling plan, SPC alerts and failures to acknowledge or raise all apply. Nothing raises a non-conformance automatically.

- **Storage and rules (CM1, migration `20260226100000`, applied live):**
  - **Format profiles:** `measurement_import_profiles` with frozen versions.
  - **Feature maps:** `measurement_feature_maps` remembers per part which CMM feature is which check.
  - **The preview:** `inspection_imports` (`IMP-YY-NNNN`), `inspection_import_units` (the parts in the file) and `inspection_import_rows` (the features). All of them are written only by functions.
  - **Recording:** `app.begin_inspection_import_apply` / `finish_inspection_import_apply`. They check every matched row became exactly that reading. A deferred trigger refuses to commit an import left half-applied, and the same file (SHA-256) is never recorded on an inspection twice.
  - **Files:** the private `inspection-files` bucket.
- **Reading and matching (CM2, migration `20260227100000`, applied live):**
  - **Table exports** are read with a profile: column headings, header labels, tolerances or limits, pass / fail words, unit, and which column splits the file into parts.
  - **Ready-made profiles:** CALYPSO table, PC-DMIS with a heading row, and a simple table.
  - **Matching:** a saved feature map first, then the balloon number. One feature per check per part.
  - **Units:** **the database converts them** (mm, µm, m, in, thou; degrees, minutes of arc), works out each row's expected result, and flags a difference from the plan larger than 1/1000 of the tolerance band.
- **Recording (CM3, no migration):** `POST /inspection-imports/{id}/apply`.
  - **New:** each part goes through `InspectionService.recordSample`, so the sampling plan decides and a file cannot add a sample the plan does not ask for.
  - **Retest:** re-measures the latest failed reading of each check.
  - **Correction:** needs a reason and `inspection.correct`, and replaces the readings of that part's sample.
- **Screens (CM4, no migration):**
  - A **Measurement files** card on the inspection page and the job hub.
  - The **preview page**: figures, header, warnings, confirming differences, matching by hand with "remember", and Record / Discard.
  - **Settings → Data Management → Process control → Measurement files**: profiles, "Try a file", versions with a reason.
  - **CMM feature matches** on the part page.
- **QIF Results (CM5, no migration):** a `.qif` / `.xml` file is read **without a profile**.
  - **XML reader:** our own small reader, which **refuses any DOCTYPE**, so no entity expansion or external reference is possible.
  - **What it takes from the file:** characteristics are followed from measurement to item (designator = balloon), nominal and definition (tolerances). Units come from `FileUnits`, and each `MeasurementResults` is one part, with its serial number.
- **PC-DMIS generic export (after CM5, no migration):**
  - **The format:** Hexagon's File › Export › Generic text has no heading row: `LABEL AX:X, nominal, +tol, -tol, measured, deviation, out of tol`. It is recognised by its lines and read without a profile.
  - **Limits:** lower = nominal − minus tolerance as written.
  - **Skipped lines:** feature and hits lines carry no limits and are skipped.
  - **Units:** none is named, so values are taken in the check's own unit.
  - **Balloons:** a label measured on one axis is tried as a balloon number.
  - **Several parts:** a dimension written again starts the next part.
- **Exit check (CM6):** this report, the live checks below, and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260227100000`; SQL tests incl. `measurement_imports` and `measurement_import_units`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (385, incl. `parse-report.spec.ts`, `match.spec.ts`, `parse-qif.spec.ts`, `parse-pcdmis-generic.spec.ts`) and `api:test:e2e` (91 suites, 1,028 tests incl. `measurement-imports` (19), and the API tenancy sweep for every new route) | pass |
| `npm test` (1,533 Vitest tests incl. `MeasurementImports.test.jsx`), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project, 2026-11-14) | **0 violations**; the audit rule lists the four audited CMM tables |
| Live migrations | `20260226100000_measurement_imports` and `20260227100000_measurement_import_units` are recorded in `schema_migrations` and were checked after they were applied: tables with RLS, the four audited, the bucket and its storage policies, no function callable by anonymous callers, every one with a fixed `search_path` |
| Advisors (security) | nothing about these tables beyond the project-wide warnings: every table is visible to GraphQL (230 objects), and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | INFO only for these tables: foreign keys without a covering index (organisation, actor and link columns) and indexes not yet used (the tables are new and empty live). The one WARN is the CAPA actions table's two update policies (CAPA6, by design) |
| Browser journey (`npm run journey`) | the whole journey passes with the new step (below) |

### The journey step (`cmmImports` in `scripts/journey/journey.cjs`)

1. **Set-up through the API:** part JRN-200 with its own control plan (bore diameter, balloon 1; overall length, balloon 2; datum offset, no balloon), the CMM `CMM-J1`, and a running job.
2. **The PC-DMIS file:** on the job hub the operator opens **Import from CMM**. The organisation has no profile, and the dialog says QIF and PC-DMIS generic files can be read anyway. They choose the CMM and drop a PC-DMIS generic export: a feature line, a hits line and four dimension lines.
3. **The preview:** it says how the file was read (as information), that two feature and hit lines were not read, that balloons 1 and 2 matched, and that DAT1 X and DAT1 Y did not.
4. **Matching by hand:** the operator matches **DAT1 X to Datum offset** by hand, with "remember" on. The feature map is saved for the part.
5. **Recording the first job:** **Record 3 readings**. The job page shows the sample recorded, the database holds three passes with the import's id, and the job is completed.
6. **The QIF file:** on the next job the operator reads a QIF file for serial SN-0002. Balloons match two checks, and **the match remembered from the PC-DMIS file matches the third**. The bore is **out of tolerance**.
7. **Recording the second job:** after recording, the database holds a fail and two passes, the job page shows "1 failed reading so far", and the sample is recorded.
8. **The part page:** it lists the remembered match under **CMM feature matches**.

## What the browser found

The import, matching, recording and both readers worked first time in the browser. Two faults were in what people see, and both are fixed:

- **"How the file was read" was shown as a warning.** "Read as a PC-DMIS generic export…" and "2 feature and hit lines … were not read" are information, not something to act on.
  - **The fix:** readers now return `notes`, stored as warnings of kind `info` (the column takes any kind, so no migration was needed), and the preview draws them as blue information callouts.
- **The upload dialog warned "No file profile yet"** even though QIF and PC-DMIS generic files can be read without one. It is now information.

One more fault was in the journey step itself, not the app: it took a screenshot of the job page before the page had refreshed after recording. The step now waits for "1 of 1 planned samples recorded".

## Rules held by the database (not only the screens)

- **No table writes** on profiles, versions, feature maps or imports: every change is a SECURITY DEFINER function.
- **Profiles:** a profile version is frozen, and a profile's format is fixed once created.
- **Previews:**
  - A preview's rows and expected results are worked out by the database, not sent by the API.
  - A mismatch must be confirmed before recording.
  - A preview over a day old cannot be recorded.
  - A header part number that is not the inspection's part is refused.
- **Readings:**
  - A reading carries `import_id` only while its import is being applied, and only with the import's gauge.
  - `finish_inspection_import_apply` checks every matched row became exactly that reading in the chosen mode.
  - A deferred trigger refuses to commit an import left `applying`.
  - The same file is recorded on an inspection once.
  - A correction needs a reason and `inspection.correct`.
- **Files:** they live in the private `inspection-files` bucket under the inspection's own folder.
- **Nothing is deleted:** a preview is discarded with an optional reason, and a feature map is ended.

## Design notes and limits

- **Real sample files are still needed (CM0).** The ready-made profiles' column names, the QIF element names and the PC-DMIS generic details have not been checked against real exports. The QIF details follow the QIF 3 schema and the PC-DMIS ones Hexagon's help page "Exporting to a Generic Text File". Open questions on PC-DMIS: spacing around the commas, whether there is a space before `AX:`, and the axis codes besides X, Y and D. Either reader can be adjusted without a migration once real files are in hand.
- **A PC-DMIS generic file names no unit, part or serial.** Its values are taken to be in each check's own unit, and the part is the inspection's. A file with several parts is split only by a dimension repeating, so the parts are "Part 1", "Part 2" in the order written.
- **A correction finds the part's sample by the file's unit reference.** For a file with no serial number (such as a PC-DMIS generic export of one part), it uses the inspection's sample holding most of the file's checks, newest first. Check the preview before recording a correction from such a file.
- **Not built:** Q-DAS DFQ (C1: when a customer needs it); reading files dropped into a watched folder or sent by the CMM directly (Phase 6 connectors); a profile per machine chosen automatically (the last one used is remembered per machine in the browser); characteristics that are not in the control plan; importing nominals into the plan from a file.

## Go-live runbook

1. **The migrations are applied live.** The API needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to read uploaded files (`InspectionFileStore`). Without them, imports answer `503 file_storage_unavailable`.
2. **QIF files and PC-DMIS generic exports need nothing set up.** For other table exports, someone with `process_control.manage` makes a profile in Settings → Data Management → Process control → Measurement files, usually from a ready-made one, and checks it with **Try a file** on a real export.
3. **Inspectors use Import from CMM** on the job hub or the inspection page. Features without a balloon number are matched by hand once with "remember" on, and later files of that part match by themselves.
4. **Send real sample files** from each CMM program (CM0) so the readers can be confirmed.
