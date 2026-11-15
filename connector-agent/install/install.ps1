<#
.SYNOPSIS
    Installs the Fortress Connector Agent as a Windows service and registers it with Fortress.

.DESCRIPTION
    Run from the unzipped package, in PowerShell as an administrator:

        .\install.ps1 -ApiUrl "https://<your Fortress address>/api/v1" -Token "FAGT-..."

    The address and the one-time token are shown in Fortress: Settings > Integrations > Connector agents > Add a connector agent.

    What it does:
      1. Copies the agent to Program Files\Fortress\ConnectorAgent.
      2. Creates the service "FortressConnectorAgent", running as its own low-privilege virtual account
         (NT SERVICE\FortressConnectorAgent), started automatically (delayed), restarted if it crashes.
      3. Limits %ProgramData%\Fortress\ConnectorAgent (the agent's keys and logs) to SYSTEM, Administrators and the service.
      4. Registers the agent: makes its keys on this machine (protected with Windows DPAPI) and sends Fortress only the public halves.
      5. Starts the service. It connects out to Fortress over HTTPS only; no inbound firewall ports are needed.

    Pilot build (docs/connector-agent-plan.md AG-D12): the files are not code-signed yet.

.PARAMETER ApiUrl
    Fortress's address for agents, exactly as shown with the token.
.PARAMETER Token
    The one-time registration token (FAGT-...). It works once and expires; it is not stored.
.PARAMETER InstallDir
    Where to put the program. Default: Program Files\Fortress\ConnectorAgent.
.PARAMETER Replace
    Register afresh over an agent already registered on this machine (use a "Reinstall" token from the agent's page in Fortress).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Fortress\ConnectorAgent'),
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'FortressConnectorAgent'
$ServiceAccount = "NT SERVICE\$ServiceName"
$DataDir = Join-Path $env:ProgramData 'Fortress\ConnectorAgent'
$Source = Join-Path $PSScriptRoot 'app'
$Exe = Join-Path $InstallDir 'FortressAgent.exe'

function Step($text) { Write-Host "-> $text" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as an administrator, then run this script again.'
}
if (-not (Test-Path (Join-Path $Source 'FortressAgent.exe'))) {
    throw "FortressAgent.exe was not found in $Source. Run this script from the unzipped package."
}
if ($Token -notmatch '^FAGT-[A-Za-z0-9_-]{43}$') {
    throw 'That is not a registration token from Fortress: it starts FAGT- and has 48 characters.'
}
if ($ApiUrl -notmatch '^https://') {
    throw 'The address must start with https://'
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Step 'Stopping the existing service to update it'
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
}

Step "Copying the agent to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $InstallDir -Recurse -Force

if (-not $existing) {
    Step "Creating the service $ServiceName (account $ServiceAccount)"
    & sc.exe create $ServiceName binPath= "`"$Exe`" run" start= delayed-auto obj= $ServiceAccount DisplayName= 'Fortress Connector Agent' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed ($LASTEXITCODE)" }
}
& sc.exe description $ServiceName 'Connects out to Fortress QMS and reads only the data you approve there. Settings > Integrations > Connector agents.' | Out-Null
# Restart after a crash (twice, a minute apart), then leave it stopped. A revoked agent stops itself cleanly and is not restarted.
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000 | Out-Null

Step "Limiting $DataDir to SYSTEM, Administrators and the service"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# SIDs, not names, so this works in any Windows language: S-1-5-18 SYSTEM, S-1-5-32-544 Administrators.
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${ServiceAccount}:(OI)(CI)M" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE)" }

Step 'Registering the agent with Fortress'
$registerArgs = @('register', '--api', $ApiUrl, '--token', $Token, '--data-dir', $DataDir)
if ($Replace) { $registerArgs += '--replace' }
& $Exe @registerArgs
if ($LASTEXITCODE -ne 0) {
    throw 'Registration failed (see above). Nothing was started. If the token was used or has expired, make a new one in Fortress and run this again.'
}
# The identity file inherits the folder's rules set above, so the service can read it and nobody else can.

Step 'Starting the service'
Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))

Write-Host ''
Write-Host 'The Fortress Connector Agent is installed and running.' -ForegroundColor Green
Write-Host 'It should show as Online in Fortress within a minute (Settings > Integrations > Connector agents).'
Write-Host "Logs: $DataDir\logs"
