# Calibration module — plan and decisions

Calibration is a Phase 4 domain in `docs/design-brief.md` (§6.7, §12). It was **brought forward**
at the product owner's request (Nov 2026), in the same way NCR core (2.4) was. It is one complete,
tested vertical slice: migration, API, pages and tests. Slice 2.2 (inspection plans) stays the
next item on the Phase 2 plan.

## Decisions (agreed)

| # | Question | Decision |
|---|----------|----------|
| C1 | Bring forward now or plan only? | Build now as a complete slice. |
| C2 | Where are calibration characteristics defined? | On **gauge types** as templates (Settings → Calibration). A new gauge of a type gets copies, which can then be edited, added to or switched off per gauge. |
| C3 | What happens when a calibration fails? | The gauge is **quarantined** automatically. The record offers **Raise NC**, which creates a draft internal NC linked to the calibration. |

## Data model (`supabase/migrations/20251106100000_calibration.sql`)

- `gauge_types`: name, description, default interval (value + days/weeks/months/years), active.
- `gauge_type_characteristics`: template checks. Each has a name, nominal, tolerance − / + (limits nominal − tol … nominal + tol), unit (from `units`), method and order.
- `gauges`:
  - identification: asset number (unique per organisation, case-insensitive), description, type, manufacturer, model and serial;
  - location: site, department (must be at the site), location and custodian;
  - measuring capability: range, unit and resolution;
  - calibration set-up: internal or external (with the lab as a supplier) and interval (defaults from the type, else 12 months);
  - status: active, in calibration, quarantined, out of service, retired or lost, with a reason;
  - dates: last calibrated and next due;
  - soft delete with a reason.
- `gauge_characteristics`: the gauge's own checks, copied from the type template on insert (`template_id` keeps the link).
- `calibrations`:
  - reference `CAL-YY-NNN`, generated;
  - who and how: date (not in the future), internal technician or external supplier, certificate number, procedure and reference standards;
  - conditions: temperature and humidity;
  - result: outcome and next due (defaults to date + gauge interval);
  - links and notes: notes and the linked NC;
  - soft delete with a reason.
- `calibration_readings`: one per characteristic.
  - Name, nominal, tolerances and unit are copied from the characteristic, so history does not change.
  - Readings: as-found (required) and as-left (after adjustment).
  - `as_found_ok` / `as_left_ok` are worked out by the database.
- `calibration_attachments`: certificates in the private `calibration-files` bucket at `<org>/calibration/<calibration id>/…`. Removal is a soft delete; stored files are never deleted by users.

### Rules in the database

- **Outcome:**
  - with readings, `pass` means every as-found reading is in tolerance;
  - `adjusted` means some were out as found, but all are in tolerance as left;
  - otherwise `fail`;
  - without readings, the outcome given is kept (e.g. an external certificate).
- **Gauge follows its latest non-deleted calibration:**
  - last calibrated and next due dates follow that record;
  - a fail quarantines an active or in-calibration gauge;
  - a pass or adjusted result returns a quarantined or in-calibration gauge to active;
  - out-of-service, retired and lost gauges keep their status.

  This runs as a *deferred* constraint trigger, so a record and its readings are judged once. The API flushes it with `SET CONSTRAINTS calibrations_after IMMEDIATE`.
- **Locking:** deleted gauges lock their characteristics and calibrations; deleted calibrations lock their readings and files.
- **Outbox events:** `calibration.recorded`, `calibration.deleted` / `restored`, `calibration.outcome_changed` and `gauge.status_changed`.
- **Errors:** SQLSTATE `QM006`; the API maps it to `409 calibration_rule`.

### Permissions

| Permission | Covers | System roles |
|------------|--------|--------------|
| `calibration.read` | gauges, records and history | all roles |
| `calibration.manage` | gauges, types and characteristics | owner, admin, quality manager, quality engineer |
| `calibration.record` | calibration records and certificates | owner, admin, quality manager, quality engineer, inspector |

- Gauges and their children are site-scoped through the gauge's site.
- Gauge types are organisation-wide: every member can read them, and `calibration.manage` changes them.

## API (`api/src/calibration/`)

- `GET/POST /gauge-types`, `PATCH /gauge-types/{id}`
- `GET/POST /gauge-types/{id}/characteristics`, `PATCH /gauge-type-characteristics/{id}`
- `GET /gauges`:
  - filters: status, `due` (overdue / due in 30 or 90 days / no due date), latest outcome, type, site, supplier, source, next-due from/to, q, deleted;
  - sort and paging as `/ncrs`.
- `POST /gauges`, `GET/PATCH /gauges/{id}`, `POST /gauges/{id}/delete|restore`, `GET /gauges/{id}/history`
- `GET/POST /gauges/{id}/characteristics`, `PATCH /gauge-characteristics/{id}`
- `GET/POST /gauges/{id}/calibrations` (record with readings in one request), `GET/PATCH /calibrations/{id}`, `POST /calibrations/{id}/delete|restore`, `POST /calibrations/{id}/raise-ncr`
- `GET/POST /calibrations/{id}/attachments`, `POST /calibration-attachments/{id}/delete|restore`
- `GET /calibration-dashboard?from&to`

## Frontend

- Menu **Calibration**:
  - Dashboard `/Calibration`: KPI cards, due-by-month, outcomes over time, status and type breakdowns, and an overdue list.
  - Gauges `/Calibration/Gauges`: the generic `Table` with the same features as the NC registers (sort, resize, reorder, show/hide, pinned select/actions columns, URL filters in the right-hand drawer, and soft delete).
- Gauge page `/Calibration/Gauges/{id}` (`new` creates):
  - details form;
  - characteristics editor;
  - calibration history;
  - change history.
- Calibration record page `/Calibration/Gauges/{id}/calibrations/{calId}` (`new` creates):
  - readings grid with live pass/fail;
  - certificates;
  - Raise NC on failure.
- Settings → Calibration: gauge types and their template characteristics.

## Not in this slice

- Reminder emails and scheduled due notifications (they need the Phase 5 outbox worker).
- MSA / gauge R&R studies.
- Uncertainty budgets.
- Check-out / issue tracking of gauges.
- Linking gauges to inspection plan characteristics (with 2.2/2.3).
