---
title: Connect an API
summary: Read records from a REST API on a schedule, map its fields to Fortress and keep both in step.
group: Admin and security
order: 50
---
A file import is a one-off. A connection keeps reading a system for you. This guide covers a **REST API** that Fortress can reach over the internet. A database, folder or API inside your own network is read by a connector agent instead: see [The connector agent](/help/connector-agent). Both feed the same import templates, previews and field rules described in [Import your data](/help/import-your-data).

Integrations are for people holding a Controller seat. You also need a role that allows integrations, and permission to write the kind of record you import.

## Connect a REST API

1. In **Settings → Integrations**, choose **Connect an API**.
2. Give it a name and a **system code**, a short word such as `erp` that names where the records came from. It is fixed once made.
3. Enter the **address**. It must start with `https://`. Addresses on a private network are refused, and Fortress does not follow redirects.
4. Choose **How we sign in**: no sign-in, an API key in a header, a bearer token, user name and password, or **OAuth client credentials**. For OAuth you give the token address (it may be another host, such as Microsoft Entra, Auth0 or Okta), and optionally a scope and an audience.
5. Under **Records**, say for each kind of record the path that returns it, where the list sits in the answer, and how it pages: one answer, page numbers, offset and limit, a cursor, or a link to the next page. For incremental reads, name the parameter to send and the field whose highest value is sent.
6. On the connection's page, **Store a credential**. It is kept encrypted and never shown again. You can only replace or revoke it.
7. **Test connection**, then **Mark ready**, then **Activate**. Someone other than the person who marked it ready must activate it, unless you are an organisation-wide Owner or Admin.

## Allowed hosts

**Settings → Integrations → Allowed hosts** limits which systems API connections may call. Empty means any public host. An entry allows that host and its sub-domains. If you use the list, the OAuth token host must be on it too. A connection to a host that is no longer allowed is paused.

## Map the fields

On the connection's page, **Read a sample** shows the first page of one kind of record without importing anything. **Map fields** turns those columns into an import template, with the same editor, steps, [formulas](/help/import-formulas) and previews as a file import. Choose **Preview** first. A preview works before the connection is active, but a real import needs it active.

## Keep it up to date

Each kind of record has a **Schedule** on the connection's page. A REST API runs by hand or daily, at about 04:00. Pick an import template and Fortress runs as the person who switched it on, checking each day that they may still do so. A run never starts while the last one is still going.

While a schedule is on, fields mapped as **Source wins** are locked for people on the records that import manages. The field shows who manages it. To keep a field editable, set it to **Fortress wins** or **Review** in the template, or switch the schedule off.

**When a record disappears from the source** you can do nothing, list it, or make it inactive. This is checked after a full read. Nothing is ever deleted, and if more than a fifth of a kind would go at once, Fortress holds them for a person.

Differences set to Review wait under **Values to review**, where you accept them or keep Fortress's value with a reason. **Import health** on the Integrations page marks each source as Healthy, Needs a look or Failing. Rejected rows stay listed, so you can fix the source, or ignore a row with a reason.

## Good to know

- Non-conformances are only ever added by an import, never updated.
- Rejected rows, records that disappear and review values are all listed for a person to decide. Nothing is silently dropped.
- Test each connection and read the first preview closely before you rely on a schedule.

See also [Start with a spreadsheet, connect your database later](/help/spreadsheet-then-database), and [Power BI and reporting](/help/power-bi-and-reporting) for reading data out of Fortress.
