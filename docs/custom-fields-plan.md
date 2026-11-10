# Custom fields — plan

Organisation-defined extra fields on Fortress records, filled in on the record's page, shown in registers and offered by imports
(`docs/import-engine-plan.md` decision E2: custom fields come first).

## 1. Agreed decisions (2026-11-10)

| # | Decision |
|---|---|
| CF-D1 | **First set of records:** parts, part families, machines, gauge types, gauges, suppliers, customers, employees, non-conformances, 8Ds, inspections, production orders, lots. Audits, quality alerts and SCARs later. |
| CF-D2 | **Required, chosen per field:** never, when the record is saved, or before the record reaches a stage (e.g. required to close an NC). Existing records are never blocked: a rule only applies to new records, to clearing a value, and to a record moving into the stage. |
| CF-D3 | **New permission `custom_fields.manage`** ("Manage custom fields"): owner, admin and quality manager. |
| CF-D4 | **Everyone who can see the record sees its custom fields**; whoever can edit the record can fill them in. |
| CF-D5 | **At most 20 active custom fields per kind of record**; at most 100 options per list. |
| CF-D6 | **No ready-made fields:** every organisation starts empty. |

## 2. Design

- **Definitions** — `custom_field_definitions` per organisation and kind of record: key (fixed once created, used by imports and
  reports), label, type, help text, section, position, required (`never` / `save` / a stage), options for lists (key fixed, label
  editable, switched off rather than removed), number decimals / unit / limits, active or retired (with a reason). Type and key never
  change; retiring keeps every value readable. Written only by functions (`custom_fields.manage`), read by every member, audited.
- **Types:** short text (≤ 500), long text (≤ 5,000), number (decimals 0–6, optional unit, min, max), date, yes / no, one choice,
  several choices, a person of the organisation.
- **Values** — `custom_field_values`: **one row per record** (primary key = the record's id, so the audit trail's entity id is the
  record), holding a jsonb object keyed by field key. Kept apart from the records so the existing locking rules of inspections, NCs and
  8Ds stay untouched. Written only by `app.set_custom_values(kind, record, values)`, which checks:
  - the caller may edit that record (the record's own edit permission);
  - the record is not locked (closed / cancelled / deleted NC, closed / cancelled 8D, finished inspection, closed / cancelled order,
    closed lot, deleted gauge);
  - every value against its definition (type, limits, decimals, active option, active member);
  - a value for a retired field or a switched-off option can only be kept or cleared;
  - a field required on save is never cleared.
  Readable under the record's own read permission.
- **Required on save** — a deferred check at the end of the transaction that creates a record (so the create and its values can be
  sent together); **required at a stage** — a trigger on the record's stage / status column when it moves from before that stage to
  it or later (cancelling and abandoning are never blocked). Stage orders: NC draft → open → contained → investigating →
  dispositioned → awaiting closure → closed; 8D open → actions in progress → awaiting verification → verified effective → closed;
  inspection in progress → completed; production order planned → released → in progress → completed → closed; lot open → released →
  closed. Errors `QM023` → `409 custom_field_rule`.

## 3. Slices

| Slice | Content |
|---|---|
| **CF1** | Database: permission, definitions, values, functions, required checks, SQL tests, guardrails and sweeps. |
| **CF2** | API: definitions (list, create, edit, retire, reactivate, reorder), `PUT /custom-values/{kind}/{id}`, `customValues` on the 13 records' detail and list rows, create bodies take `customValues`, register filters on custom fields; e2e and sweeps. |
| **CF3** | Screens: Settings → Data Management → **Custom fields**; a **More details** card on the 13 record pages; register columns (hidden at first) and filters; CSV export. |
| **CF4** | Imports: the catalogue offers each organisation's custom fields, the importers write them, the drift test knows the values table. |

## 4. Status (2026-11-10)

All four slices are built: CF1 database, CF2 API, CF3 screens, CF4 imports (see CLAUDE.md "Custom fields" for the detail). Known gaps: saved filters
do not keep custom field filters; the one-click calibration "Raise NC" and the NC page's "Start a new 8D" have nowhere to enter values, so a field
required on save on NCs / 8Ds refuses them; inline production orders made by inspectors cannot write order custom values; imports cover the eight
importable kinds only.
