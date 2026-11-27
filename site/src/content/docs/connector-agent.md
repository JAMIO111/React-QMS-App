---
title: The connector agent
summary: Install a small Windows service inside your network so Fortress can read a database, folder or internal API without opening your firewall.
group: Admin and security
order: 51
---
Some systems cannot be reached from the internet: a database server, a shared folder, an internal API. The connector agent is a small Windows service you install inside your network. It connects **out** to Fortress, so nothing connects in. It reads SQL Server, PostgreSQL and MySQL or MariaDB, CSV and Excel files in a folder or share, and REST APIs on your network. What it reads feeds the same import templates, previews and field rules as any other import: see [Import your data](/help/import-your-data) and [Connect an API](/help/connect-an-api).

Integrations are for people holding a Controller seat. You also need a role that allows integrations, and permission to write the kind of record you import.

## Install the agent

1. In **Settings → Integrations → Connector agents**, choose **Manage agents**, then add an agent. Name it and choose how long its token lasts, from one hour to seven days.
2. Copy the **registration token**. It is shown once and works once.
3. On a Windows machine inside your network, run the installer as an administrator and give it the Fortress address and the token.
4. The agent shows as **Online** within a minute. **Check now** on its page confirms it answers.

## Connect a source

1. Choose a card such as **Microsoft SQL Server**, **PostgreSQL**, **Files in a folder** or **Internal API**, pick the agent and enter where it is.
2. Type the password, key or token on the connection page. It is sealed in your browser for that agent and kept only on that machine. Windows authentication has no password: the agent signs in as its own service account.
3. **Browse the database**, choose a table or view, and choose **Use this table**. Name the column that identifies each row.
4. Optionally name a **column that shows when a row changed**. With it, an incremental import reads only the changes.
5. Folders use a file name pattern, and Fortress reads the newest matching file. Internal APIs use an endpoint.
6. Map the fields, preview and activate as for any connection: **Test connection**, **Mark ready**, then **Activate**. Someone other than the person who marked it ready must activate it, unless you are an organisation-wide Owner or Admin.

## Keep it up to date

Each kind of record has a **Schedule** on the connection's page. An agent connection can run by hand, every 5 minutes, every 15 minutes, hourly or daily, while the agent is online. A run never starts while the last one is still going, and one that fails is tried again on the next. While the agent is offline, scheduled runs are not started.

The rest works as for an API connection: fields mapped as **Source wins** are locked for people while a schedule is on, records that disappear are listed or made inactive, and differences set to Review wait for a person. See [Connect an API](/help/connect-an-api#keep-it-up-to-date).

## What the agent may reach

On the agent's machine, `allowlist.json` in the data folder (`%ProgramData%\Fortress\ConnectorAgent`) lists what it may read.

- **Databases, schemas and objects** are optional. Empty means whatever the sign-in can read, so give the agent a login that can only read what Fortress needs.
- **Folders**, **hosts** and **servers** work the other way. If you do not list them, the agent reads no folder, calls no API and uses Windows authentication on no server.

Fortress never sends SQL. It sends a structured request, and the agent builds a read-only query. A stored password is tied to the server or address it was typed for. If you change that, it is cleared and you type it again.

## Updates and keys

An agent updates only when someone who manages integrations approves a release on its **Updates** card. Releases are signed, and the agent checks the signature itself. If a new version does not check in within five minutes, the previous one is put back. The agent replaces its own keys every 90 days. **Revoke** an agent from its page if a machine is lost.

## Good to know

- The agent is new. Compare the key fingerprint on its page with the one printed by `FortressAgent.exe status`, and test each connection before you rely on it.
- Rejected rows, records that disappear and review values are all listed for a person to decide. Nothing is silently dropped.

See also [Start with a spreadsheet, connect your database later](/help/spreadsheet-then-database).
