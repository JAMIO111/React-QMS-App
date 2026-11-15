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

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as an administrator, then run this script again.'
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

if (Test-Path $InstallDir) {
    Write-Host "-> Removing $InstallDir"
    Remove-Item -Recurse -Force $InstallDir
}
if ($RemoveData -and (Test-Path $DataDir)) {
    Write-Host "-> Removing $DataDir"
    Remove-Item -Recurse -Force $DataDir
}
Write-Host 'The Fortress Connector Agent has been removed.' -ForegroundColor Green
