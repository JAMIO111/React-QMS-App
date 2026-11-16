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
      3. Copies the agent again to Program Files\Fortress\ConnectorAgentUpdater and creates the service "FortressConnectorAgentUpdater"
         (LocalSystem, started only on demand). It swaps in an update you approved in Fortress, after checking the release's signature
         again with its own built-in keys. The agent's own account may start it and nothing else.
      4. Makes %ProgramData%\Fortress\ConnectorAgent (the agent's keys, passwords and logs) owned by Administrators and limited to
         SYSTEM, Administrators and the service. A folder already there that someone else owns is refused: look at it, delete it, run again.
      5. Puts an empty allowlist.json there that the service can read but not change (only an administrator edits it).
      6. Registers the agent: makes its keys on this machine (protected with Windows DPAPI) and sends Fortress only the public halves.
      7. Starts the service. It connects out to Fortress over HTTPS only; no inbound firewall ports are needed.

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

# Security descriptors by SID, so this works in any Windows language.
$ServiceSid = 'S-1-5-80-3434563925-585952842-2424198147-1152564101-3769421330'   # NT SERVICE\FortressConnectorAgent
$UpdaterName = 'FortressConnectorAgentUpdater'
$UpdaterDir = Join-Path (Split-Path $InstallDir -Parent) 'ConnectorAgentUpdater'
$UpdaterExe = Join-Path $UpdaterDir 'FortressAgent.exe'
$TrustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')   # SYSTEM, Administrators, TrustedInstaller

function Assert-TrustedOwner($path) {
    if (-not (Test-Path $path)) { return }
    $owner = (Get-Acl $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    # Windows makes a folder an administrator creates theirs, so the person running this and the members of Administrators are trusted too.
    $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value })
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($TrustedOwners -notcontains $owner -and $admins -notcontains $owner -and $owner -ne $me) {
        throw "$path already exists and is owned by $owner, not by SYSTEM or an administrator. Someone may have prepared it to read the agent's keys. Look at what is in it, delete it, then run this again."
    }
}

function Set-FolderSecurity($path, $sddl) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetSecurityDescriptorSddlForm($sddl)
    Set-Acl -Path $path -AclObject $acl
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Step 'Stopping the existing service to update it'
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
}
$existingUpdater = Get-Service -Name $UpdaterName -ErrorAction SilentlyContinue
if ($existingUpdater -and $existingUpdater.Status -ne 'Stopped') {
    Step 'Waiting for an update in progress to finish'
    $existingUpdater.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(10))
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

Step "Copying the updater to $UpdaterDir"
New-Item -ItemType Directory -Force -Path $UpdaterDir | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $UpdaterDir -Recurse -Force
$updaterCommand = "`"$UpdaterExe`" apply-update --install `"$InstallDir`" --service $ServiceName --data-dir `"$DataDir`""
if ($existingUpdater) {
    $cim = Get-CimInstance Win32_Service -Filter "Name='$UpdaterName'"
    $r = Invoke-CimMethod -InputObject $cim -MethodName Change -Arguments @{ PathName = $updaterCommand; StartMode = 'Manual'; StartName = 'LocalSystem' }
    if ($r.ReturnValue -ne 0) { throw "The updater service could not be changed ($($r.ReturnValue))" }
} else {
    Step "Creating the service $UpdaterName (LocalSystem, started only on demand)"
    New-Service -Name $UpdaterName -BinaryPathName $updaterCommand -StartupType Manual -DisplayName 'Fortress Connector Agent Updater' `
        -Description 'Swaps in a Fortress Connector Agent update approved in Fortress, after checking its signature. Started by the agent; stops when done.' | Out-Null
}
# Who may do what to the updater service: SYSTEM and Administrators as usual, signed-in users may look, and the agent's own account may start it
# (RP) and read its state - nothing else, so the agent cannot change what the updater runs.
& sc.exe sdset $UpdaterName "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;RPLCLOCRRC;;;$ServiceSid)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe sdset failed ($LASTEXITCODE)" }

$FortressData = Split-Path $DataDir -Parent
Assert-TrustedOwner $FortressData
Assert-TrustedOwner $DataDir
Step "Limiting $DataDir to SYSTEM, Administrators and the service"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# The folder above: owned by Administrators, so nobody else can rename or replace the agent's folder.
Set-FolderSecurity $FortressData 'O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
# The agent's folder: SYSTEM and Administrators full control, the service modify (not delete-child), nobody else; inheritance blocked.
Set-FolderSecurity $DataDir "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$ServiceSid)"
# Anything already inside (logs, identity) takes those rules and nothing else.
if (Get-ChildItem -Force $DataDir) {
    & icacls.exe "$DataDir\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE)" }
}

$AllowList = Join-Path $DataDir 'allowlist.json'
if (-not (Test-Path $AllowList)) {
    Step 'Adding an empty allow-list (allowlist.json): edit it as an administrator to limit what the agent reads'
    Copy-Item -Path (Join-Path $PSScriptRoot 'allowlist.json') -Destination $AllowList
}
# The customer's own limit on the agent: the service may read it, only an administrator may change it.
$fileAcl = New-Object Security.AccessControl.FileSecurity
$fileAcl.SetSecurityDescriptorSddlForm("O:BAG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ServiceSid)")
Set-Acl -Path $AllowList -AclObject $fileAcl

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
