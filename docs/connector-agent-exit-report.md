# Fortress Connector Agent — exit report

**Date:** 2026-11-16 · **Plan:** `docs/connector-agent-plan.md` (decisions AG-D1–AG-D12, AG6-D1–D5) · **Slices:** AG0–AG6 · **Branch:** `Dev`

## What was built

A small Windows service (.NET 10, `connector-agent/`) that a customer installs inside their network. It connects **out** to Fortress over HTTPS, takes jobs that people approved in Fortress, and reads only what its own allow-list and its sign-in permit. Rows go into the **existing** import pipeline: templates, mapping, preview, field ownership, missing records and health all work unchanged.

- **Identity and trust (AG1):** a one-time `FAGT-…` token; keys made on the machine (ECDSA P-256 for signing, P-256 for sealing) and protected with DPAPI; every request signed (timestamp ±300 s, nonce once); revoke, reinstall, key rotation every 90 days (AG6a).
- **What it reads:**
  - SQL Server, PostgreSQL, MySQL / MariaDB (AG2–AG5a): read-only transactions, catalogue names only, every value a parameter, never SQL from the cloud;
  - files in allowed folders (AG5b): the agent sends bytes and the API parses them;
  - internal REST APIs (AG5c): allowed hosts only, no redirects, flattened exactly as the cloud connector does.
- **Passwords:** sealed in the browser to the agent's key (ECDH → HKDF → AES-GCM, with the connection as associated data). Fortress passes them on without being able to read them and drops the sealed bytes when the job ends. **Since AG6d a password is bound to where it was typed for.**
- **Imports (AG3–AG4):** batches of up to 1,000 rows, gzipped and checksummed, stored once and in order, resumable. Incremental reads by a changed column. Schedules every 5 / 15 / 60 minutes, hourly or daily.
- **Resilience (AG6a):** in-job retries for about three minutes; a dropped database connection is a passing failure that resumes; a diagnostics bundle (≤ 64 kB, redacted).
- **Updates (AG6b):** releases signed with an offline release key and published by an operator. An organisation approves each update, and the agent checks it again with its own built-in keys. **Since AG6d the Windows swap is done by a separate LocalSystem updater service** that checks everything again.
- **Installer and CI (AG6c):** a WiX MSI, `install.ps1` / `uninstall.ps1`, an Authenticode signing script, and a GitHub Actions workflow that builds and checks all of it on Windows and runs the adapters against real SQL Server 2022 and MySQL 8.

## Security review (AG6d)

A reviewer who had not written the code went through the whole agent path: agent, API guard and routes, migrations, install scripts. Each finding was checked against the code before it was accepted. The table is in the plan (§19 "AG6d security review"); in short:

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | A stored password followed a connection that was later pointed at another server, database or address; Windows sign-in could be aimed at any host; an engine switch could turn a password into an HTTP Basic header | High | **Fixed and tested.** Password bound to its target, both on the agent (`ConnectionTarget`) and in the database (cleared when the target changes, engine change refused). Allow-list `"servers"`: Windows sign-in only to listed servers. PostgreSQL never sends a cleartext password |
| 2 | Data folder could be prepared by a non-administrator; the service could rewrite its own allow-list | Medium | **Fixed.** The data folder and its parent are owned by Administrators; anything already inside is reset; `install.ps1` refuses a folder someone else owns; `allowlist.json` is read-only for the service. Checked by CI on Windows |
| 3 | `.xlsx` unpacking unbounded in the API | Medium | **Fixed and tested** (150 MB total, 120 MB a part, 5,000 entries) |
| 4 | No rate limit on agent routes; every bad signature cost a database query | Low | **Fixed and tested** (registration rate-limited; 30 failures a minute from one address → `429` before any database work) |
| 5 | The Windows swap ran as an account that cannot do it and trusted files that account can write | Low | **Fixed and unit-tested; checked on Windows by CI.** A separate updater service (LocalSystem, on demand); the agent may only start it; the release is checked again and unpacked from a copy only the updater can write |
| 6 | A key sent to an internal API over plain http; a link below an allowed folder; the sealing key comes from Fortress | Low | **Fixed and tested:** a key goes over http only with `"plainHttpSignIn": true`; links below an allowed folder are refused and link files are never read. **Accepted:** a compromised Fortress could hand the browser another sealing key. The agent's fingerprint is shown in Fortress and by `FortressAgent status` for comparison |

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260314100000`, incl. the new `agent_hardening` test) | pass (135 SQL test files) |
| `npm run api:test` (432) | pass |
| `npm run api:test:e2e` (incl. the agent suites and the tenancy sweep) | pass (1,116 tests in 101 suites; the real-agent suite runs separately) |
| Agent tests (`dotnet test`, incl. the real PostgreSQL and MariaDB adapters) | pass (156) |
| Real agent against the real API (`connector-agent/run-e2e.sh`: registration, passwords, browse, imports, incremental, folders, internal API incl. the plain-http refusal, recovery cases, a signed update staged) | pass (agent tests, then the real agent end to end) |
| `npm test` (1,606), `npm run lint` (0 errors), `npm run build` | pass |
| Browser journey (`npm run journey`, new step `connectorAgent()`) | pass: token shown once, the agent registers and is Online, Check now answered, the password sealed in the browser is opened by the agent exactly as typed and no sealed bytes are kept, revoke stops the agent |
| Load test (AG-D4), **100,000 rows** of a 20-column PostgreSQL table through the real agent (a million was not run: about an hour of import here) | **pass.** First import: read by the agent and sent in 100 batches in 29 s, all 100,000 machines created in 248 s, none lost or duplicated. Same import again: 19 s, 100,000 unchanged, nothing written. Agent peak memory 217 MB (it streams; it never holds the table). **It found a real fault, now fixed:** a run's page counted its rows under row-level security, one permission check per row, and at this size passed the 15-second statement limit, so a large import's status could not be read at all (any kind of import). Migration `20260315100000_integration_run_rows_fast.sql` counts and pages a run's rows with one permission check and indexed reads |
| Live guardrails (after `20260314100000_agent_hardening.sql` was applied live, 2026-11-16) | **0 violations**; the migration recorded, both triggers enabled, `set_agent_credential` sends the connection, the new functions not callable by `authenticated` or `anon` |
| Windows CI (`.github/workflows/connector-agent.yml`, run 8 on 2026-11-16) | **pass.** Real databases: the 156 agent tests against SQL Server 2022, MySQL 8 and PostgreSQL 16. Windows Server: the release MSI and a test MSI built with WiX 5; 41 checks pass — install with the token (not in the installer log), the agent service (own virtual account, delayed automatic start, restarted after a crash, registers, heartbeats), the updater service (LocalSystem, on demand, the agent may only start it), the data folder and allow-list permissions, clean removal that revokes the agent, **an approved update swapped in by the updater and checked in, a broken update rolled back to the previous version**, and no leftovers after self-updates; the 156 agent tests also pass on Windows (DPAPI, paths). **The first runs found real faults, all fixed:** SQL Server `date` columns read as a date-time and an unreachable SQL Server reported as refused (so never retried); the installer project did not build under WiX 5 (an XML comment, the refused `ServiceConfig` table, empty file harvesting, the renamed folder-removal step, a duplicate step name); and test faults (a hidden-file test, a Postgres sign-in, a service-rights check that compared text) |

## Windows acceptance list (for the first customer machine)

CI runs most of this on a clean Windows Server. These need a real customer-like machine:

1. Install the **signed** MSI on Windows Server 2019 or 2022 with `API_URL` and `TOKEN`. Expected: SmartScreen shows the publisher; the agent shows Online within a minute.
2. Compare the key fingerprint shown on the agent's page in Fortress with the one printed by `"C:\Program Files\Fortress\ConnectorAgent\FortressAgent.exe" status`.
3. A SQL Server connection with **Windows authentication**: list the server under `"servers"` in `allowlist.json` (Notepad as administrator). Give `NT SERVICE\FortressConnectorAgent` (or, for a remote server, the machine account) read access. Test, browse and import.
4. A SQL Server connection with a SQL login on a named instance (`SQLEXPRESS`), with and without encryption.
5. A folder on a network share (`\\server\exports`): the machine account needs read access; list the share under `"folders"`.
6. Through the customer's outbound proxy, if any.
7. An update approved in Fortress (once a release key exists): it is swapped in and checks in. Then a deliberately broken release (heartbeats refused): it is rolled back within about six minutes.
8. Uninstall: Fortress shows the agent revoked; `Program Files\Fortress` is gone; `%ProgramData%\Fortress\ConnectorAgent` keeps only the logs and the allow-list.

## What you need to do

- ~~Apply the hardening migration~~ — done 2026-11-16.
- **Make a release key** on your own computer: `node connector-agent/release/make-release-key.mjs <file>`. Keep the private key off this repository. Add the public key to `ReleaseKeys.Built` (`connector-agent/src/Fortress.Agent.Core/Updates.cs`) and to the API's `AGENT_RELEASE_KEYS`. Until then no update is accepted.
- **A code-signing certificate** for the MSI and the exe:
  - add it as the GitHub secrets `FORTRESS_SIGN_PFX_BASE64` and `FORTRESS_SIGN_PFX_PASSWORD`;
  - or, for a certificate on a hardware token or cloud HSM (now the norm for new certificates), run the workflow on a self-hosted Windows runner with `FORTRESS_SIGN_THUMBPRINT`.
  - Run the workflow with **require_signature** for a release.
- ~~Push so the Windows workflow runs~~ — done; it passes (run 8, 2026-11-16).

## Not built

- Private-key JWT and authorisation-code sign-in for internal APIs.
- A sealing-key fingerprint shown beside the password box.
- Per-agent bandwidth limits.
- A Linux service package (the agent runs on Linux for tests and pilots only).
- Automatic updates without approval (on purpose).
