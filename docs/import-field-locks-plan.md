# Import field locks — plan

Status: LK1–LK4 built and tested, migration applied live 2026-11-22 (custom fields, part revisions and order lines are not covered); the browser journey passes with the lock steps. Decision LK-D1 agreed 2026-11-22: **a field is locked only while a schedule is on.**

## 1. What the owner asked for

A scheduled refresh updates fields 1 and 2 of a record, field 3 stays controlled in Fortress. For the fields the import controls, Fortress forms should
disable the input and show a tooltip saying why.

## 2. What exists today (inspected)

- **Per-field ownership** is already in the import template (`integration_template_versions.fields[].ownership`): absent = source wins,
  `qms_wins` = the import never writes it, `manual_review` = a differing value is parked in `integration_conflicts` for a person.
  Applied by the database in `app.system_import_record` (IN5, migration `20260120100000`). `app.integration_ownership(fields)` lists the non-default ones.
- **Schedules** are `integration_import_settings.schedule` (`manual`, `daily`, `every_5m`, `every_15m`, `hourly`) per connection and kind of record, with
  `template_id`; the worker step runs them (IN8, AG4). The write mode is `add_only | add_update | update_only`; only the last two update records.
- **Which record an import owns** is `integration_external_records` (connection, kind, source id → Fortress record id).
- **Where a catalogue field lands** is `ENTITY_COLUMNS` in `api/src/integrations/core/columns.ts` (field key → column), already kept honest by the drift test.
- **Not there:** nothing in the forms reads any of this. A person can type in a field the import owns (and the next run overwrites it), and there is no
  tooltip component (only chart tooltips; fields have a `hint` line).

## 3. Rule (LK-D1 and consequences)

A field of a record is **locked** when all of these hold, worked out live, never stored:

1. the record has a row in `integration_external_records` for connection C and kind K;
2. C is `active` (not draft, ready, paused or retired);
3. `integration_import_settings` for (C, K) has `schedule <> 'manual'` and the schedule's template version writes with `add_update` or `update_only` (a template always records its write mode, and a run takes it over the connection's, so the connection's own setting does not matter);
4. the schedule's template (`template_id`, its **current** version) maps that field and its ownership is source wins (absent).

Consequences, all deliberate:

- Switch the schedule off, pause or retire the connection, or change the field to **Fortress wins** in a new template version: the field unlocks at once.
- `manual_review` fields stay editable (a person's edit is what the review compares against). Unmapped fields are never touched by an import, so never locked.
- A hand-made record the import has not linked is not locked (it is linked at the first import that matches it).
- An offline agent, a failing run or a record missing from the source does **not** unlock: the next good run would overwrite the edit. The unlock paths above
  are the way out. There is no admin bypass.
- NCs, goods receipts, legacy calibrations and received totals are add-only, so nothing is ever locked on them. Part revisions (`revision`, in another table)
  and purchase order lines are out of the first version (see §8).

## 4. Database (LK1)

Migration `2026…_import_field_locks.sql` (SQL test `supabase/tests/import_field_locks.test.sql`):

- `app.integration_field_columns(entity) → jsonb` {catalogue field → column}, written from `ENTITY_COLUMNS`; the drift test also compares it with the
  TypeScript map, so the two cannot differ.
- `app.integration_locked_fields(org, entity, record) → table(field, column, connection_id, connection_name)`: SECURITY DEFINER; the caller must be a member
  who can read that kind of record (same read check the form already passes); returns only the field, the column and the connection's name — no settings,
  no template, no credentials. Empty for anyone else, never an error that reveals the record.
- `app.integration_lock_guard()` BEFORE UPDATE trigger (`TG_ARGV[0]` = kind) on `suppliers`, `customers`, `parts`, `machines`, `"Employees"`, `gauge_types`,
  `gauges`, `production_orders`: skips the import itself (the transaction setting the import already sets — to be confirmed in LK1 whether it is
  `app.integration_import` or `app.source = 'integration'`, and tested both ways) and system roles; for a person it compares `to_jsonb(OLD)` and
  `to_jsonb(NEW)` on the locked columns and refuses a change with `QM033` (new code, to be confirmed unused) naming the fields and the connection. Unchanged
  values pass, so forms that send every field still save. Runs after `touch_updated`; one primary-key lookup when the record is not linked.
- SQL mutants: guard removed (caught), import exempt removed (import blocked), schedule `manual` still locks, `add_only` still locks, paused still locks,
  `qms_wins` / `manual_review` locked, unlinked record locked, another organisation's record revealed, columns map missing a field.

## 5. API (LK2)

- `GET /import-locks?entityType&recordId` (any member; empty list when nothing is locked) → `{ data: [{ field, connection }] }` where `field` is the
  catalogue key (the same word the form uses). Sweep entry, e2e: locked / unlocked / paused / schedule off / unlinked / other organisation.
- `QM033` → `409 field_managed_by_import` with `details { fields, connection }`; the edit-conflict dialog is not involved.
- A test per kind that a PATCH of a locked field is refused and of an unlocked one saved.

## 6. Frontend (LK3)

- `ui/Tooltip.jsx`: hover and keyboard focus, Escape closes, `data-popover` portal, `aria-describedby`. Disabled inputs do not take hover, so the trigger is a
  small lock icon button beside the label (and the whole field wrapper), not the input.
- A `lockedBy` prop on the shared field wrapper (`Field` and the combo / date / text controls that draw their own label) that disables the control, draws the
  lock and the tooltip: "Managed by <connection>. It updates this field on a schedule, so edits here would be overwritten." plus a line saying how to change
  that for people who can (switch the field to Fortress wins).
- `hooks/useImportLocks(entityType, recordId)` → `{ lockOf(field) }`; a mutation refreshes it (schedule, template and connection changes go through
  `refreshOrganisation`, so it is already invalidated). `lib/importLocks.js` holds the catalogue-key → form-field names; a test fails when a lockable
  catalogue field has no form mapping and no stated reason.
- Wired into: customers and suppliers dialogs and the supplier quality dialog, parts, machines, employees, gauge types, gauges, production orders. Row
  actions that write a locked column (for example deactivate) rely on the database refusal and show its message in v1.

## 7. Where people set it (LK4)

- Mapping page ownership choice: words that say what each means for people ("Source wins: while a schedule is on, this field cannot be edited in
  Fortress"). Schedule card: "While this schedule is on, N fields on the records it manages cannot be edited in Fortress", with the list.
- Custom fields (`cf_<key>`) lock the same way in the More details card (the guard on `set_custom_values`), if the first slices go cleanly.
- Journey step: schedule on, open a managed record, the field is disabled with its tooltip and a direct API edit is refused; schedule off, it edits.
- CLAUDE.md entry, exit notes in this file.

## 8. Not in the first version

Purchase order lines (agreed date), part revisions, bulk or register inline edits getting the disabled state up front, a per-record "unlock once"
override, a notice when a person edits a field that is about to be locked.

## 8a. LK1 as built

Migration `20260418100000_import_field_locks.sql`, test `supabase/tests/import_field_locks.test.sql` (eight deliberate breaks caught; the ninth, removing the `is_member` check, is redundant because `has_permission_somewhere` repeats it), drift tests added to `api/test/integration-catalogue-drift.e2e-spec.ts`. The import's marker is `app.source = 'integration'` (set by `app.system_import_record`), error code `QM033` (unused before). Lookup index `integration_external_records_entity_internal_idx`. `app.integration_field_columns` and `app.integration_lock_table` are not callable by people.

## 8b. LK2 as built

`GET /import-locks?entityType&recordId` (`api/src/integrations/import-locks.*`, any member; `{ data: [{ field, connection: { id, name } }] }`, 400 for a kind that is never locked) and `QM033` → `409 field_managed_by_import` with `details { fields, connection }` (`common/database-errors.ts`). Test `api/test/import-locks.e2e-spec.ts` (8 cases: no lock while manual, listed once scheduled, refused with details, unmapped and unchanged values save, unmanaged record free, other organisation told nothing, unlocks at once) and a sweep query in `tenancy-sweep.e2e-spec.ts`.

## 8c. LK3 as built

`ui/Tooltip.jsx` (hover and keyboard focus, Escape closes, `data-popover` portal), `ui/LockedMark.jsx` (a lock button beside the label that carries the tooltip), `lib/importLocks.js` (`lockMessage`, `lockKey`: a form's own name → the catalogue key, e.g. `siteId` → `site`), `hooks/useImportLocks.js` (`lock("name")` → `{ lockedBy, disabled: true }` or `{}`). `lockedBy` is accepted by `Field`, `TextInput`, `RHFComboBox` (so `ComboField` and the pickers), `RHFDatePickerPopout`, `RHFTextArea`, `TextAreaField`, `Switch` and `SelectField`; `AddressFields` and `CompanyContactFields` take a `lock` function. Wired into: customers and suppliers dialog, the supplier quality dialog, part details, machines, employees, gauge types (Settings), the gauge page and the production order dialog. An accessible name of a locked field reads "Name Managed by ERP" (the lock's label is inside the field's label). Tests `ui/LockedFields.test.jsx` and two in `master-data/MasterData.test.jsx`. Row actions and registers rely on the database refusal and show its message.

## 8d. LK4 as built

Ownership words on the mapping page now say what each choice means for people (source wins locks the field while a schedule is on; Fortress wins and review stay editable). The connection's Schedule card (`KeepHealthy.jsx`) lists, from the schedule's template, the fields people cannot edit (`fieldsOwnedBySource` in `lib/importLocks.js`: source-wins fields of an updating template for the eight guarded kinds, leaving out custom fields and a part's revision). The journey (`importFromApi` in `scripts/journey/journey.cjs`) saves the API template as "Add new and update existing", switches a daily schedule on, sees the note, opens a machine whose name is locked (disabled, lock with tooltip), edits an unmapped field, has the database refuse a direct change (`QM033`), switches the schedule off and sees the field free. **Custom field locks were left out**: they need the same guard on `app.set_custom_values` and a lock in the More details card, so they are a separate small slice if wanted.

## 9. Slices

LK1 database and SQL test → LK2 API and e2e → LK3 tooltip, hook and the forms → LK4 settings words, custom fields, journey, docs. Each ends with
`npm run db:check` (LK1, LK2), api tests, lint, vitest and build. No push until told.
