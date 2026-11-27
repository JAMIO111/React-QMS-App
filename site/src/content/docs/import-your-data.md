---
title: Import your data
summary: Bring parts, suppliers, machines and more in from a CSV or Excel file, and keep them in step with other systems.
group: Admin and security
order: 47
---
You do not have to type your master data. **Settings → Integrations** imports it for you.

## What can be imported

Parts, suppliers, customers, machines, employees, gauge types, gauges, legacy calibration records, non-conformances, NC cost lines, production orders, purchase orders, goods receipts and received quantities, customer orders and shipments, plus any custom fields you have added. Non-conformances arrive as drafts unless the source gives a stage, and they are only ever added, never updated.

## Import a file

Choose **CSV or Excel file** and follow the four steps:

1. **Choose records.** Pick the kind of record you are importing.
2. **Upload a file.** Fortress works out the encoding and separator. Check the first rows and change the settings if they look wrong.
3. **Filter records.** Optionally choose which rows of the file are read at all, for example only rows where a status column says Active. Fortress says how many records are kept, and a filter that keeps nothing is flagged.
4. **Map columns.** Pick the column that identifies each record, then match columns to Fortress fields. Required fields without a source are marked, and each row shows an example from your file. Links to other records, such as a part's customer, use codes.

At the bottom of the mapping step, **Preview** writes nothing: you see which rows would be added, changed, skipped or rejected, with the reason for each. **Import** then writes them.

Choose what an import may do: add new records only, add and update, or update only. Rejected rows stay listed. Fix the source, import again, and rows that have not changed write nothing.

## Templates

Your mapping is saved as a **template** with versions, so next month's file is one click. Changing a template asks for a reason and makes a new version. Where it is switched on, a formula editor handles values the standard steps cannot; every function and rule is in [Formulas in imports](/help/import-formulas).

## When the source and Fortress disagree

For each field you choose whether the **source wins**, **Fortress wins**, or a person should **review** the difference. Parked differences wait on the Review page.

## Connecting other systems

- **REST APIs** can be read on a schedule, with API key, bearer, basic or OAuth sign-in. See [Connect an API](/help/connect-an-api).
- The **connector agent** is a small Windows service you install inside your network. It reads SQL Server, PostgreSQL and MySQL databases, network folders and internal APIs. It only connects outwards, and your database password stays on that machine. See [The connector agent](/help/connector-agent).

Starting from a spreadsheet and moving to a database later is covered in [Start with a spreadsheet, connect your database later](/help/spreadsheet-then-database).

Integrations are managed by people holding a Controller seat. The person who runs an import needs permission to write that kind of record.
