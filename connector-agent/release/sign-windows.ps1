<#
.SYNOPSIS
    Code-signs (Authenticode) the Fortress Connector Agent's files: FortressAgent.exe before it is packaged, the MSI after it is built.

.DESCRIPTION
    docs/connector-agent-plan.md AG6c. Uses signtool.exe from the Windows SDK and an RFC 3161 timestamp, so signatures stay valid after the
    certificate expires. The certificate comes from one of:

      -Thumbprint <sha1>      a certificate already in the machine's or user's store (or on a hardware token / cloud HSM whose provider puts it there)
      $env:FORTRESS_SIGN_PFX_BASE64 + $env:FORTRESS_SIGN_PFX_PASSWORD
                              a .pfx given as GitHub Actions secrets; written to a temporary file for signing and deleted afterwards

    With neither, nothing is signed and the script says so (exit 0) unless -Required is given (exit 1): an unsigned pilot build is allowed,
    a release build is not. Nothing secret is ever printed.

.EXAMPLE
    .\sign-windows.ps1 -Files ..\bin\msi-app\FortressAgent.exe -Required
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Files,
    [string]$Thumbprint = $env:FORTRESS_SIGN_THUMBPRINT,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$Description = 'Fortress Connector Agent',
    [switch]$Required
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $found = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $found) { throw 'signtool.exe was not found: install the Windows 10/11 SDK (Signing Tools).' }
    return $found.FullName
}

foreach ($f in $Files) { if (-not (Test-Path $f)) { throw "Not found: $f" } }

$pfxBase64 = $env:FORTRESS_SIGN_PFX_BASE64
if (-not $Thumbprint -and -not $pfxBase64) {
    if ($Required) { Write-Error 'No signing certificate (give -Thumbprint or FORTRESS_SIGN_PFX_BASE64): a release must be signed.'; exit 1 }
    Write-Warning 'No signing certificate configured: the files are left unsigned (pilot build). Windows SmartScreen will ask users to confirm.'
    exit 0
}

$signtool = Find-SignTool
$common = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/d', $Description)
$pfxPath = $null
try {
    if ($Thumbprint) {
        $signArgs = $common + @('/sha1', $Thumbprint)
    } else {
        $pfxPath = Join-Path ([IO.Path]::GetTempPath()) ("sign-" + [Guid]::NewGuid().ToString('N') + '.pfx')
        [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($pfxBase64))
        $signArgs = $common + @('/f', $pfxPath)
        if ($env:FORTRESS_SIGN_PFX_PASSWORD) { $signArgs += @('/p', $env:FORTRESS_SIGN_PFX_PASSWORD) }
    }
    foreach ($f in $Files) {
        # Timestamp servers fail now and then: try three times.
        $ok = $false
        for ($i = 1; $i -le 3 -and -not $ok; $i++) {
            & $signtool @signArgs $f | Out-Null
            $ok = $LASTEXITCODE -eq 0
            if (-not $ok) { Start-Sleep -Seconds (5 * $i) }
        }
        if (-not $ok) { throw "Signing failed: $f" }
        & $signtool verify /pa /q $f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "The signature does not verify: $f" }
        Write-Host "Signed and verified: $f"
    }
} finally {
    if ($pfxPath -and (Test-Path $pfxPath)) { Remove-Item -Force $pfxPath }
}
