# Fortress Connector Agent

A Windows service the customer installs inside their network. It connects **out** to Fortress over HTTPS, takes the jobs Fortress has for
it and answers them. Plan and decisions: `docs/connector-agent-plan.md` (AG1: registration, signed requests, heartbeat, jobs, ping; AG2: databases; AG3: extraction for imports).

```
src/Fortress.Agent.Core     identity and keys, request signing, the API client, the run loop, job handlers (ping)
src/Fortress.Agent.Host     FortressAgent.exe: Windows service + commands (register, run, status, deregister), logs
tests/Fortress.Agent.Tests  xUnit: contract, identity, registration, run loop (fake Fortress)
contract/                   fixtures both the API and the agent test against (signature vector, message bodies)
install/                    install.ps1, uninstall.ps1, README.txt for the pilot package
spike/                      the AG0 spike (kept for reference)
```

## Build and test

.NET 10 SDK (`~/.dotnet` in the cloud container: `export PATH=$HOME/.dotnet:$PATH`).

- `dotnet test` (from this folder) — the agent's own tests.
- `bash run-e2e.sh` — builds the agent and runs it against the real API and a migrated throwaway Postgres
  (`api/test/connector-agent-binary.e2e-spec.ts`): register with a token, come online, answer a ping, stop when revoked.
- `bash package.sh` — the Windows pilot zip in `bin/` (self-contained `FortressAgent.exe`, no .NET needed on the machine).

## How it works

- **Identity.** `register` makes two P-256 keys on the machine — signing (ECDSA) and sealing (ECDH, for credentials sealed in the
  browser, AG2) — and sends Fortress only the public halves with the one-time token. The private keys stay in
  `%ProgramData%\Fortress\ConnectorAgent\agent.json`, protected with DPAPI for the machine, in a folder only SYSTEM, Administrators and
  the service can open. The token is never stored.
- **Every request is signed**: `FORTRESS-AGENT-V1 \n METHOD \n path?query \n sha256(body) \n unix time \n nonce \n agent id`, ECDSA
  P-256 / SHA-256, 64-byte r‖s, base64. The API checks the time (±5 minutes), refuses a nonce twice and checks the organisation's network
  policy. Redirects are never followed.
- **Loop.** Heartbeat; take up to ten jobs; sleep as long as Fortress says (15 s while someone has the agent's page open or jobs are
  waiting, else 60 s); back off 5 s → 5 min when Fortress cannot be reached (Retry-After honoured). When Fortress says the agent is revoked
  it stops and the service exits cleanly (exit code 0, so Windows does not restart it).
- **Jobs.** Ack → run → complete or fail. An unknown kind fails with "update the agent"; an unexpected error is reported by type only
  (exception messages can hold connection strings). Progress reports tell a handler when the job was cancelled.
- **Logs.** `%ProgramData%\Fortress\ConnectorAgent\logs`, one file a day, kept 14 days; ids, kinds and counts only.

## Not yet checked on Windows

The Windows service, DPAPI protection, `install.ps1` / `uninstall.ps1` and the folder permissions have not been run on a Windows machine
(there is none here). Everything else is tested on Linux with the same code. The first install on the Windows machine with SQL Server
(plan §11) is the AG1 acceptance check.

## Databases (AG2)

- **Adapters** (`src/Fortress.Agent.Adapters`): PostgreSQL (Npgsql) and SQL Server (Microsoft.Data.SqlClient). Read only: each call is a
  read-only transaction (SQL Server: `ApplicationIntent=ReadOnly`, read committed, rolled back), the catalogue is read with the login's own
  rights, and the only query that touches data is built from the columns the catalogue listed, quoted, with the row count as a parameter.
  SQL Server has not yet run against a real server (none in the build container).
- **Passwords**: typed in Fortress, sealed in the browser to this agent's sealing key, opened here (`SealedBox`) and kept one file per
  connection in `credentials\` (DPAPI). Fortress never holds them readable. Windows authentication needs none: the agent signs in as its service
  account, so give that account read access to the database.
- **Allow-list** (optional): `%ProgramData%\Fortress\ConnectorAgent\allowlist.json`, read afresh for every job:
  ```json
  { "databases": ["ERP"], "schemas": ["dbo"], "objects": ["erp.orders", "erp.v_*"] }
  ```
  Names ignore case and `*` matches anything. Without the file the agent reads whatever its database login can — which is why the login should
  be read-only and limited to what Fortress needs.
- `bash run-e2e.sh` also runs the PostgreSQL adapter tests against the throwaway database over TCP, and the real agent through a database
  connection (password, test, browse, preview, and an import read in batches).

## Extraction for imports (AG3)

- An `extract` job names a table or view, the column that identifies each row, which columns (or all) and simple filters
  (`eq ne gt gte lt lte is_null not_null`). The agent checks every name against the catalogue and builds one SELECT per page:
  `WHERE key IS NOT NULL [AND key > @after] [AND filters] ORDER BY key` with the row count, the last key and every filter value as parameters
  (sent as text: the database reads each as its column's type). Rows with no key value are not read.
- Rows go to Fortress in **batches of at most 1,000** as gzip of `{"seq","lastKey","rows"}` (`POST .../jobs/{id}/batches`,
  `Content-Type: application/gzip`, `X-Batch-Checksum` = SHA-256 of the JSON inside). A page that would be over 900 kB compressed (or 7 MB of
  JSON) is sent in halves. Text values are cut at 5,000 characters.
- Fortress keeps each batch once and in order; a job taken again after a restart or a transient failure carries on from where Fortress's
  batches end (the job says the next batch number and the last key it holds). Completing the job is refused unless Fortress holds every batch.
- A preview reads at most 1,000 rows; an import reads the whole table.
