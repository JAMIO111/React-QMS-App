# Fortress Connector Agent

A Windows service the customer installs inside their network. It connects **out** to Fortress over HTTPS, takes the jobs Fortress has for
it and answers them. Plan and decisions: `docs/connector-agent-plan.md` (AG1 = this: registration, signed requests, heartbeat, jobs, ping).

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
