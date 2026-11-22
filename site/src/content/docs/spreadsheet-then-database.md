---
title: Start with a spreadsheet, connect your database later
summary: Load your records from a file today, then hand them over to SQL Server on a schedule, with some fields owned by Fortress and some by the database.
group: Admin and security
order: 10
---
A common path is to start from a spreadsheet and, once Fortress is working for you, let your own database keep some of the data up to date. Nothing has to be re-entered when you switch, and you choose, field by field, who is in charge.

## Step 1: load the spreadsheet

Follow [Import your data](/help/import-your-data). Make sure the column that identifies each record (a part number, a supplier code) holds the same value your database uses as its key. That value becomes the record's **code** in Fortress, and it is how the two are joined later.

## Step 2: connect the database

Install the **connector agent** on a machine inside your network (it only connects outwards, and the database password stays on that machine). In **Settings → Integrations**, add a SQL Server connection through the agent, then:

1. **Choose the table or view** that holds the records, and the column that identifies each row.
2. **Optionally choose a "last changed" column.** With one, each run reads only what changed since the last run.
3. **Map the fields** with the same template editor you used for the spreadsheet.
4. **Preview** before anything is written.

## Step 3: join the two without duplicates

In the import settings for that kind of record, switch on **match existing records by code**. On the first run, each row in your database is matched to the Fortress record with the same code, so the records you loaded from the spreadsheet are kept and updated, not duplicated. From then on, Fortress remembers which database row belongs to which record.

A row whose code matches nothing is added as a new record. Choose **add and update** so existing records are updated as well as new ones created.

## Step 4: decide who owns each field

On every mapped field you choose what happens when the record already exists:

| Choice | What it means |
| --- | --- |
| **Source wins** | The database value replaces the Fortress value on every run. |
| **Fortress wins** | The database never changes this field on an existing record. |
| **Review** | A different value waits on the Review page for a person to accept or reject. |

Fortress enforces this itself, not just on screen. If a field should never come from the database at all, simply do not map it.

A new record takes every mapped field the first time it is created. The ownership choice applies from then on, to updates.

## Step 5: set the schedule

Choose how often the connection reads the table: every 5 minutes, every 15 minutes, hourly or daily. A run never starts while the previous one is still going, and a failed run is picked up again on the next one. Rows that need a person, and records that have disappeared from the database, are listed for you to decide on. If more than a fifth of a kind of record would be switched off in one run, Fortress holds them for a person instead.

## Good to know

- Non-conformances are always added as drafts and are never matched or updated by an import.
- The Review choice is not available for custom fields.
- Integrations are managed by people holding a Controller seat, and whoever runs an import needs permission to write that kind of record.
