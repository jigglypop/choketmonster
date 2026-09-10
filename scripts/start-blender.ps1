$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$blenderBinary = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
if (!(Test-Path -LiteralPath $blenderBinary)) { throw "Blender is not installed at $blenderBinary" }
$listener = Get-NetTCPConnection -LocalPort 9878 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output 'Port 9878 already has a listener. Inspecting it without restarting any process.'
    python (Join-Path $PSScriptRoot 'blender-call.py') --out (Join-Path $projectRoot 'artifacts/blender-connection.json')
    exit $LASTEXITCODE
}
$runtimeDirectory = Join-Path $projectRoot 'artifacts/blender'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$bridgeScript = Join-Path $PSScriptRoot 'blender-bridge.py'
$process = Start-Process -FilePath $blenderBinary -ArgumentList @('--background', '--factory-startup', '--python', $bridgeScript) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'bridge.log') -RedirectStandardError (Join-Path $runtimeDirectory 'bridge-error.log')
$process.Id | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'bridge.pid')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-NetTCPConnection -LocalPort 9878 -State Listen -ErrorAction SilentlyContinue) { break }
    Start-Sleep -Milliseconds 300
}
python (Join-Path $PSScriptRoot 'blender-call.py') --out (Join-Path $projectRoot 'artifacts/blender-connection.json')
exit $LASTEXITCODE
