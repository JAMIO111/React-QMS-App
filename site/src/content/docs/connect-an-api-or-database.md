---
title: Connect an API or database
summary: Read records from a REST API, or from a database, folder or internal API on your own network, and keep Fortress in step on a schedule.
group: Admin and security
order: 50
---
A file import is a one-off. A connection keeps reading a system for you. Fortress offers two routes. A **REST API** that Fortress can reach over the internet is read directly. A database, folder or API that sits inside your network is read by a **connector agent** that you install there. Both feed the same import templates, previews and field rules described in [Import your data](/help/import-your-data).

Integrations are for people holding a Controller seat. You also need a role that allows integrations, and permission to write the kind of record you import.

## Connect a REST API

1. In **Settings → Integrations**, choose **Connect an API**.
2. Give it a name and a **system code**, a short word such as `erp` that names where the records came from. It is fixed once made.
3. Enter the **address**. It must start with `https://`. Addresses on a private network are refused, and Fortress does not follow redirects.
4. Choose **How we sign in**: no sign-in, an API key in a header, a bearer token, user name and password, or **OAuth client credentials**. For OAuth you give the token address (it may be another host, such as Microsoft Entra, Auth0 or Okta), and optionally a scope and an audience.
5. Under **Records**, say for each kind of record the path that returns it, where the list sits in the answer, and how it pages: one answer, page numbers, offset and limit, a cursor, or a link to the next page. For incremental reads, name the parameter to send and the field whose highest value is sent.
6. On the connection's page, **Store a credential**. It is kept encrypted and never shown again. You can only replace or revoke it.
7. **Test connection**, then **Mark ready**, then **Activate**. Someone other than the person who marked it ready must activate it, unless you are an organisation-wide Owner or Admin.

**Settings → Integrations → Allowed hosts** limits which systems API connections may call. Empty means any public host. An entry allows that host and its sub-domains. If you use the list, the OAuth token host must be on it too. A connection to a host that is no longer allowed is paused.

## Map the fields

On the connection's page, **Read a sample** shows the first page of one kind of record without importing anything. **Map fields** turns those columns into an import template, with the same editor, steps, [formulas](/help/import-formulas) and previews as a file import. Choose **Preview** first. A preview works before the connection is active, but a real import needs it active.

## Keep it up to date

Each kind of record has a **Schedule** on the connection's page. A REST API runs by hand or daily, at about 04:00. Pick an import template and Fortress runs as the person who switched it on, checking each day that they may still do so. A run never starts while the last one is still going.

While a schedule is on, fields mapped as **Source wins** are locked for people on the records that import manages. The field shows who manages it. To keep a field editable, set it to **Fortress wins** or **Review** in the template, or switch the schedule off.

**When a record disappears from the source** you can do nothing, list it, or make it inactive. This is checked after a full read. Nothing is ever deleted, and if more than a fifth of a kind would go at once, Fortress holds them for a person. Differences set to Review wait under **Values to review**, where you accept them or keep Fortress's value with a reason. **Import health** on the Integrations page marks each source as Healthy, Needs a look or Failing. Rejected rows stay listed so you can fix the source, or ignore a row with a reason.

## Connect a database, folder or internal API

The connector agent is a Windows service. It connects out to Fortress, so nothing connects in. It reads SQL Server, PostgreSQL and MySQL or MariaDB, CSV and Excel files in a folder or share, and REST APIs on your network.

1. In **Settings → Integrations → Connector agents**, choose **Manage agents**, then add an agent. Name it and choose how long its token lasts, from one hour to seven days.
2. Copy the **registration token**. It is shown once and works once.
3. On a Windows machine inside your network, run the installer as an administrator and give it the Fortress address and the token. The agent shows as **Online** within a minute. **Check now** on its page confirms it answers.
4. Choose a card such as **Microsoft SQL Server**, **PostgreSQL**, **Files in a folder** or **Internal API**, pick the agent and enter where it is.
5. Type the password, key or token on the connection page. It is sealed in your browser for that agent and kept only on that machine. Windows authentication has no password: the agent signs in as its own service account.
6. **Browse the database**, choose a table or view, and choose **Use this table**. Name the column that identifies each row. A **column that shows when a row changed** is optional, but with it an incremental import reads only the changes. Folders use a file name pattern, and Fortress reads the newest matching file. APIs use an endpoint.
7. Map the fields, preview and activate as above. Agent connections can also run every 5 minutes, every 15 minutes or hourly while the agent is online.

## What the agent may reach

On the agent's machine, `allowlist.json` in the data folder (`%ProgramData%\Fortress\ConnectorAgent`) lists what it may read. Databases, schemas and objects are optional, and empty means whatever the sign-in can read, so give the agent a login that can only read what Fortress needs. **Folders**, **hosts** and **servers** work the other way: if you do not list them, the agent reads no folder, calls no API and uses Windows authentication on no server. Fortress never sends SQL. It sends a structured request, and the agent builds a read-only query.

A stored password is tied to the server or address it was typed for. If you change that, it is cleared and you type it again.

## Updates and keys

An agent updates only when someone who manages integrations approves a release on its **Updates** card. Releases are signed, and the agent checks the signature itself. If a new version does not check in within five minutes, the previous one is put back. The agent replaces its own keys every 90 days. **Revoke** an agent from its page if a machine is lost.

## Good to know

- The agent is new. Compare the key fingerprint on its page with the one printed by `FortressAgent.exe status`, and test each connection before you rely on it.
- Non-conformances are only ever added by an import, never updated.
- Rejected rows, records that disappear and review values are all listed for a person to decide. Nothing is silently dropped.

See also [Start with a spreadsheet, connect your database later](/help/spreadsheet-then-database), and [Power BI and reporting](/help/power-bi-and-reporting) for reading data out of Fortress.
