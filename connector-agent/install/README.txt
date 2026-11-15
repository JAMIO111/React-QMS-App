Fortress Connector Agent - pilot build

The agent is a small Windows service you install inside your network. It connects OUT to Fortress over HTTPS and reads only
the data you approve in Fortress. Nothing connects in, so no firewall ports need opening.

Requirements
  - Windows Server 2016 or later, or Windows 10/11, 64-bit. No .NET install is needed.
  - Outbound HTTPS (port 443) to your Fortress address (through your proxy, if you use one).
  - The machine's clock set to sync automatically (Fortress refuses requests more than five minutes out).

Install
  1. In Fortress: Settings > Integrations > Connector agents > Add a connector agent. Copy the address and the token.
  2. Unzip this package on the Windows machine.
  3. Open PowerShell as an administrator in the unzipped folder and run:
         powershell -ExecutionPolicy Bypass -File .\install.ps1 -ApiUrl "<address>" -Token "<token>"
  4. The agent shows as Online in Fortress within a minute. Use "Check now" on its page to test it.

Databases
  For a database connection, give the agent a login that can only read. With Windows authentication it signs in as
  its service account (NT SERVICE\FortressConnectorAgent). To limit what it may read whatever the login allows, put an
  allowlist.json in %ProgramData%\Fortress\ConnectorAgent (see the README in the repository).

Logs
  %ProgramData%\Fortress\ConnectorAgent\logs  (one file a day, kept 14 days; no passwords or data rows are ever logged)

Remove
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1      (add -RemoveData to delete the logs too)

This pilot build is not code-signed yet; Windows SmartScreen may ask you to confirm.
