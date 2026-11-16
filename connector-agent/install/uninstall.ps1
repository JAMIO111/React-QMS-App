<#
.SYNOPSIS
    Removes the Fortress Connector Agent from this machine.

.DESCRIPTION
    Run in PowerShell as an administrator:  .\uninstall.ps1  [-RemoveData] [-Force]

    Stops and deletes the service, tells Fortress to revoke the agent (so its key can never be used again) and removes the program.
    The agent's identity is removed; logs are kept unless -RemoveData is given.
    -Force removes the agent here even if Fortress cannot be told; then revoke it in Fortress yourself
    (Settings > Integrations > Connector agents > the agent > Revoke).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Fortress\ConnectorAgent'),
    [switch]$RemoveData,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'FortressConnectorAgent'
$DataDir = Join-Path $env:ProgramData 'Fortress\ConnectorAgent'
$Exe = Join-Path $InstallDir 'FortressAgent.exe'
$UpdaterName = 'FortressConnectorAgentUpdater'
$UpdaterDir = Join-Path (Split-Path $InstallDir -Parent) 'ConnectorAgentUpdater'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as an administrator, then run this script again.'
}

$updater = Get-Service -Name $UpdaterName -ErrorAction SilentlyContinue
if ($updater -and $updater.Status -ne 'Stopped') {
    Write-Host '-> Waiting for an update in progress to finish'
    $updater.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(10))
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
    Write-Host '-> Stopping the service'
    Stop-Service -Name $ServiceName -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
}

if (Test-Path $Exe) {
    Write-Host '-> Telling Fortress to revoke this agent'
    $deregisterArgs = @('deregister', '--data-dir', $DataDir)
    if ($Force) { $deregisterArgs += '--force' }
    & $Exe @deregisterArgs
    if ($LASTEXITCODE -ne 0) { throw 'Fortress could not be told, so nothing was removed. Run again with -Force to remove it anyway.' }
}

if ($service) {
    Write-Host '-> Deleting the service'
    & sc.exe delete $ServiceName | Out-Null
}

if ($updater) {
    Write-Host '-> Deleting the updater service'
    & sc.exe delete $UpdaterName | Out-Null
}

# The program, the updater's copy, and what an update leaves beside the program (the release it unpacked, the version it replaced).
foreach ($folder in @($InstallDir, $UpdaterDir, "$InstallDir.staging", "$InstallDir.previous") + @(Get-ChildItem -Directory -Path (Split-Path $InstallDir -Parent) -Filter "$(Split-Path $InstallDir -Leaf).failed-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
    if (Test-Path $folder) {
        Write-Host "-> Removing $folder"
        Remove-Item -Recurse -Force $folder
    }
}
if ($RemoveData -and (Test-Path $DataDir)) {
    Write-Host "-> Removing $DataDir"
    Remove-Item -Recurse -Force $DataDir
}
Write-Host 'The Fortress Connector Agent has been removed.' -ForegroundColor Green
