<#
.SYNOPSIS
    Checks the Fortress Connector Agent on a real Windows machine (AG6c): the MSI, the two services, the folder permissions, registration and
    the update swap with rollback. Run as an administrator; .github/workflows/connector-agent.yml runs it on a GitHub-hosted Windows runner.

.DESCRIPTION
    Part A, the release MSI (built exactly as shipped):
      install with API_URL and TOKEN -> the token is not in the installer log; the agent service runs as NT SERVICE\FortressConnectorAgent,
      delayed automatic start, restarted after a crash; the updater service runs as LocalSystem, on demand, and its security lets the agent's
      account start it and nothing more; the data folder and the folder above it are owned by Administrators with exactly the expected rules;
      allowlist.json is read-only for the service; the agent registers and sends heartbeats; removal tells Fortress, removes both services and
      the program, and keeps the data folder.
    Part B, the test MSI (a build that also trusts a throwaway release key given in its environment):
      install without a token, register by hand, start; an update to 0.99.0 is staged by the agent, swapped in by the updater service (started
      by the agent's own account) and checks in; an update to 0.99.1 that never checks in (the fake Fortress refuses its heartbeats) is rolled
      back to 0.99.0 by the updater after five minutes, and 0.99.0 reports it.

    Uses connector-agent/ci/fake-fortress.mjs (needs node on the PATH).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseMsi,
    [Parameter(Mandatory = $true)][string]$TestMsi,
    [Parameter(Mandatory = $true)][string]$NewZip,
    [Parameter(Mandatory = $true)][string]$RollbackZip,
    [int]$Port = 8787,
    [string]$Work = (Join-Path $env:RUNNER_TEMP 'agent-checks')
)

$ErrorActionPreference = 'Stop'
$AgentService = 'FortressConnectorAgent'
$UpdaterService = 'FortressConnectorAgentUpdater'
$ServiceSid = 'S-1-5-80-3434563925-585952842-2424198147-1152564101-3769421330'
$InstallDir = Join-Path $env:ProgramFiles 'Fortress\ConnectorAgent'
$UpdaterDir = Join-Path $env:ProgramFiles 'Fortress\ConnectorAgentUpdater'
$DataDir = Join-Path $env:ProgramData 'Fortress\ConnectorAgent'
$Api = "http://127.0.0.1:$Port/api/v1"
$Token = 'FAGT-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'   # the shape of a real token; the fake Fortress accepts any
$failures = New-Object System.Collections.Generic.List[string]

New-Item -ItemType Directory -Force -Path $Work | Out-Null
$StateFile = Join-Path $Work 'fake-state.json'
# The step's own log is lost when a job is cancelled; this copy goes into the uploaded logs.
Start-Transcript -Path (Join-Path $Work 'checks-output.txt') -Force | Out-Null

function Check($ok, $what) {
    if ($ok) { Write-Host "  ok   $what" -ForegroundColor Green }
    else { Write-Host "  FAIL $what" -ForegroundColor Red; $failures.Add($what) }
}
function State { Get-Content -Raw $StateFile | ConvertFrom-Json }
function Wait-Until([scriptblock]$condition, [int]$seconds, [string]$what) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try { if (& $condition) { return $true } } catch { }
        Start-Sleep -Seconds 3
    }
    Write-Host "  (gave up waiting $seconds s for: $what)" -ForegroundColor Yellow
    return $false
}
function Invoke-Fake($path, $body) {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
}
function Msi($arguments, $log) {
    $p = Start-Process msiexec.exe -ArgumentList "$arguments /qn /l*v `"$log`"" -Wait -PassThru
    return $p.ExitCode
}
function Owner($path) { (Get-Acl $path).GetOwner([Security.Principal.SecurityIdentifier]).Value }
function Rules($path) {
    (Get-Acl $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
        ForEach-Object { "$($_.IdentityReference.Value)=$([int]$_.FileSystemRights)/$($_.IsInherited)" } | Sort-Object
}
function FileVersion($exe) { $v = (Get-Item $exe).VersionInfo; "$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart)" }
function Service($name) { Get-CimInstance Win32_Service -Filter "Name='$name'" }

Write-Host '-> Starting the fake Fortress'
$fake = Start-Process node -ArgumentList "`"$PSScriptRoot\fake-fortress.mjs`" $Port `"$StateFile`"" -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $Work 'fake.log') -RedirectStandardError (Join-Path $Work 'fake.err')
try {
    if (-not (Wait-Until { Test-Path $StateFile } 30 'the fake Fortress')) { throw 'The fake Fortress did not start' }

    # ---------------------------------------------------------------- Part A: the release MSI
    Write-Host '== Part A: release MSI'
    $logA = Join-Path $Work 'install-release.log'
    Check ((Msi "/i `"$ReleaseMsi`" API_URL=`"$Api`" TOKEN=`"$Token`"" $logA) -eq 0) 'the release MSI installs with API_URL and TOKEN'
    Check (-not (Select-String -Path $logA -SimpleMatch $Token -Quiet)) 'the token is not in the installer log'

    $agent = Service $AgentService
    Check ($null -ne $agent) 'the agent service exists'
    Check ($agent.StartName -eq "NT SERVICE\$AgentService") "the agent runs as NT SERVICE\$AgentService (is $($agent.StartName))"
    Check ($agent.StartMode -eq 'Auto') 'the agent starts automatically'
    Check ((Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$AgentService").DelayedAutostart -eq 1) 'the agent start is delayed'
    Check (((& sc.exe qfailure $AgentService) -join ' ') -match 'RESTART') 'the agent is restarted after a crash'
    Check (Wait-Until { (Get-Service $AgentService).Status -eq 'Running' } 90 'the agent service running') 'the agent service is running'

    $updater = Service $UpdaterService
    Check ($null -ne $updater) 'the updater service exists'
    Check ($updater.StartName -eq 'LocalSystem') "the updater runs as LocalSystem (is $($updater.StartName))"
    Check ($updater.StartMode -eq 'Manual') 'the updater starts only on demand'
    Check ($updater.PathName -match 'apply-update' -and $updater.PathName -match [regex]::Escape($UpdaterDir)) 'the updater runs its own copy with apply-update'
    $sddl = (& sc.exe sdshow $UpdaterService) -join ''
    # Windows writes the rights in its own order (LCRPLOCRRC for what the MSI asked as RPLCLOCRRC): compare them as a set.
    $ace = [regex]::Match($sddl, "\(A;;([A-Z]+);;;$ServiceSid\)")
    $rights = if ($ace.Success) { ([regex]::Matches($ace.Groups[1].Value, '..') | ForEach-Object Value | Sort-Object) -join ',' } else { '' }
    Check ($rights -eq 'CR,LC,LO,RC,RP') "the agent's account may start the updater and only that ($sddl)"
    Check (-not ($sddl -match "\(A;;[A-Z]*(WP|DC|WD|WO|SD)[A-Z]*;;;$ServiceSid\)")) "the agent's account cannot change or stop the updater"

    $fortress = Split-Path $DataDir -Parent
    Check ((Owner $fortress) -eq 'S-1-5-32-544') "$fortress is owned by Administrators"
    Check ((Owner $DataDir) -eq 'S-1-5-32-544') "$DataDir is owned by Administrators"
    Check ((Get-Acl $DataDir).AreAccessRulesProtected) "$DataDir does not inherit"
    $expected = @("S-1-5-18=2032127/False", "S-1-5-32-544=2032127/False", "$ServiceSid=1245631/False") | Sort-Object
    $actual = @(Rules $DataDir)
    Check (($actual -join ';') -eq ($expected -join ';')) "$DataDir allows exactly SYSTEM, Administrators and the service ($($actual -join ', '))"
    $allow = Join-Path $DataDir 'allowlist.json'
    Check (Test-Path $allow) 'allowlist.json is there'
    $serviceRights = (Get-Acl $allow).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $ServiceSid }
    $write = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    Check ($serviceRights -and -not ($serviceRights | Where-Object { ([int]$_.FileSystemRights -band [int]$write) -ne 0 })) 'the service may read allowlist.json but not change or delete it'

    Check (Wait-Until { (State).registered.Count -ge 1 } 60 'registration') 'the MSI registered the agent'
    Check (Test-Path (Join-Path $DataDir 'agent.json')) 'the identity is in the data folder'
    Check (Wait-Until { (State).heartbeats.Count -ge 2 } 90 'heartbeats') 'the agent sends heartbeats'

    $logX = Join-Path $Work 'uninstall-release.log'
    Check ((Msi "/x `"$ReleaseMsi`"" $logX) -eq 0) 'the release MSI removes cleanly'
    Check ((State).deregistered -ge 1) 'removal told Fortress to revoke the agent'
    Check ($null -eq (Service $AgentService) -and $null -eq (Service $UpdaterService)) 'both services are gone'
    Check (-not (Test-Path $InstallDir) -and -not (Test-Path $UpdaterDir)) 'the program and the updater copy are gone'
    Check ((Test-Path $DataDir) -and -not (Test-Path (Join-Path $DataDir 'agent.json'))) 'the data folder is kept, the identity is not'

    # ---------------------------------------------------------------- Part B: the update swap and rollback
    Write-Host '== Part B: updates (test MSI)'
    $logB = Join-Path $Work 'install-test.log'
    Check ((Msi "/i `"$TestMsi`"" $logB) -eq 0) 'the test MSI installs without a token'
    Check ((Get-Service $AgentService).Status -eq 'Stopped') 'without a token the agent is installed but not started'

    $key = (Invoke-RestMethod "http://127.0.0.1:$Port/_release-key").publicKey
    foreach ($name in @($AgentService, $UpdaterService)) {
        New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -PropertyType MultiString -Force `
            -Value @("FORTRESS_AGENT_TEST_RELEASE_KEY=$key", "FORTRESS_AGENT_TEST_DOWNLOAD=http://127.0.0.1:$Port/package.zip") | Out-Null
    }
    & (Join-Path $InstallDir 'FortressAgent.exe') register --api $Api --token $Token --data-dir $DataDir
    Check ($LASTEXITCODE -eq 0) 'registered by hand'
    Start-Service $AgentService
    $first = FileVersion (Join-Path $InstallDir 'FortressAgent.exe')
    Check (Wait-Until { @((State).heartbeats | Where-Object version -eq $first).Count -ge 1 } 90 "a heartbeat from $first") "version $first is online"

    Invoke-Fake '/_release' @{ zip = (Resolve-Path $NewZip).Path; version = '0.99.0' } | Out-Null
    Check (Wait-Until { @((State).reports | Where-Object { $_.outcome -eq 'applied' -and $_.reportedBy -eq '0.99.0' }).Count -ge 1 } 420 'update 0.99.0 applied') 'the update to 0.99.0 was swapped in by the updater and checked in'
    Check ((FileVersion (Join-Path $InstallDir 'FortressAgent.exe')) -eq '0.99.0') 'the install folder holds 0.99.0'
    Check (Wait-Until { (Get-Service $UpdaterService).Status -eq 'Stopped' } 120 'the updater stopping') 'the updater service stopped when done'
    Check ((Service $UpdaterService).ExitCode -eq 0) 'the updater finished with "applied" (exit 0)'

    Invoke-Fake '/_refuse' @{ version = '0.99.1' } | Out-Null
    Invoke-Fake '/_release' @{ zip = (Resolve-Path $RollbackZip).Path; version = '0.99.1' } | Out-Null
    Check (Wait-Until { @((State).reports | Where-Object { $_.outcome -eq 'rolled_back' -and $_.reportedBy -eq '0.99.0' }).Count -ge 1 } 720 'update 0.99.1 rolled back') 'an update that never checks in is rolled back and reported by 0.99.0'
    Check ((FileVersion (Join-Path $InstallDir 'FortressAgent.exe')) -eq '0.99.0') 'the install folder holds 0.99.0 again'
    Check ((Get-Service $AgentService).Status -eq 'Running') 'the agent is running after the rollback'

    $logY = Join-Path $Work 'uninstall-test.log'
    Check ((Msi "/x `"$TestMsi`"" $logY) -eq 0) 'the test MSI removes cleanly after self-updates'
    Check (-not (Test-Path $InstallDir) -and -not (Test-Path "$InstallDir.staging") -and -not (Test-Path "$InstallDir.previous")) 'no update leftovers in Program Files'
}
catch {
    $failures.Add("the checks stopped early: $($_.Exception.Message)")
    Write-Host "  FAIL the checks stopped early: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    $logs = Join-Path $DataDir 'logs'
    if (Test-Path $logs) { Copy-Item -Recurse -Force $logs (Join-Path $Work 'agent-logs') -ErrorAction SilentlyContinue }
    # Whatever happened, leave the machine clean for the next step: an agent left running (a check failed before the
    # uninstall) may be what made the later test step hang in run 9.
    foreach ($msi in @($TestMsi, $ReleaseMsi)) {
        if ((Service $AgentService) -or (Service $UpdaterService)) {
            Start-Process msiexec.exe -ArgumentList "/x `"$msi`" /qn" -Wait -ErrorAction SilentlyContinue | Out-Null
        }
    }
    foreach ($name in @($AgentService, $UpdaterService)) {
        if (Service $name) {
            Stop-Service $name -Force -ErrorAction SilentlyContinue
            & sc.exe delete $name | Out-Null
        }
    }
    Get-Process FortressAgent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if ($fake -and -not $fake.HasExited) { Stop-Process -Id $fake.Id -Force }
}

Write-Host ''
if ($failures.Count) {
    Write-Host "$($failures.Count) check(s) failed:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Stop-Transcript | Out-Null
    exit 1
}
Write-Host 'All Windows checks passed.' -ForegroundColor Green
Stop-Transcript | Out-Null
