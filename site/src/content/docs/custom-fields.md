---
title: Custom fields
summary: Add your own fields to records, decide when they are required, and use them in registers and imports.
group: Admin and security
order: 42
---
Custom fields let you record what your business needs without waiting for a new feature. Fortress comes with no ready-made custom fields: you add the ones you want.

## Which records can have them

Parts, part families, machines, customers, suppliers, employees, gauge types, gauges, non-conformances, 8Ds, inspections, production orders and lots.

## Add a field

You need the permission to manage custom fields. Under **Settings → Data Management** choose the **Custom fields** tab, pick the **Kind of record**, then choose **Add field**.

- **Label**: what people see. Labels must differ within a kind of record.
- **Type**: short text (500 characters), long text (5,000), number, date, yes / no, one choice, several choices, or person (a member of the organisation). The type cannot change later.
- **Section**: fields with the same section show together.
- **Required**: not required, required when the record is saved, or required before the record reaches a stage. Stages are offered only where a record has them: non-conformances, 8Ds, inspections, production orders and lots.
- **Help text**: shown under the field.
- A number field can have decimal places (0 to 6), a unit and lowest and highest values.
- A choice field has a list of options. You can switch an option off but not remove it.

A kind of record can have up to 20 active fields. Use the arrows to move fields up and down.

## Required fields

A field required on save must be filled in when the record is created, and cannot be cleared later. A field required before a stage must be filled in before the record moves to that stage. Records that already exist are never blocked by a new rule: it applies to new records and when a record moves on. Cancelled, abandoned and on-hold records do not block.

## Where people see and use them

- **More details** is a card on the record's page (on the NC page it comes second in the page menu). Each field has the control that fits its type. Text, number and date fields save when you leave them.
- On a form that creates a record, only the fields required on save are shown. The rest are on the record once it exists.
- In registers, custom fields are available as columns, hidden until you choose them from the column menu. They are not sortable. The registers for non-conformances, 8Ds, inspections, employees, suppliers, gauges, production orders and lots also offer them in the filter drawer, and in a CSV export. The master data lists offer them as columns.
- Saved filters do not keep custom field filters yet.
- Importing: every active custom field is offered as a field to map. See [Import your data](/help/import-your-data). Imports skip empty values, so an import never clears a custom value. Part families, 8Ds, inspections, production orders and lots cannot be imported, so their custom fields cannot either.

## Retire a field

Choose **Retire** on a field and say why. The values already recorded are kept. A retired field shows on a record only if it holds a value. Open **Retired fields** and choose **Bring back** to use it again, within the limit of 20.

## Good to know

- A locked record accepts only a save that changes nothing. Closed or cancelled non-conformances and 8Ds, finished inspections, closed or cancelled orders, closed lots and deleted gauges are locked.
- If a scheduled import owns a custom field, it is locked on the record with a lock mark. See [Import your data](/help/import-your-data).
- Everyone who can see a record sees its fields.
