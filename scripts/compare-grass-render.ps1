param([string]$BaselineRef = 'ac4cf34b383dbb8de8f5c2aa2c1bc2fa4b656a92', [string]$Label = 'grass-ab')
$ErrorActionPreference = 'Stop'
# Run while the terminal's pnpm dev server is already running, with no other GPU tests.
# Only the owned material source changes temporarily; always restore it, including on failure.
$workspace = Split-Path $PSScriptRoot -Parent
$materialPath = Join-Path $workspace 'src/openworld/materials.tsx'
$candidate = [IO.File]::ReadAllText($materialPath)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$priorDpr = $env:WORLD_FIXED_DPR
$priorWarmup = $env:WORLD_WARMUP_MS
Push-Location $workspace
try {
  $baseline = git show "${BaselineRef}:src/openworld/materials.tsx"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read the baseline material source' }
  $env:WORLD_FIXED_DPR = '1'
  $env:WORLD_WARMUP_MS = '10000'
  [IO.File]::WriteAllText($materialPath, ($baseline -join "`n") + "`n", $utf8)
  pnpm exec tsx scripts/measure-world-runtime.ts "$Label-baseline" surface
  if ($LASTEXITCODE -ne 0) { throw 'Baseline capture failed' }
  [IO.File]::WriteAllText($materialPath, $candidate, $utf8)
  pnpm exec tsx scripts/measure-world-runtime.ts "$Label-candidate" surface
  if ($LASTEXITCODE -ne 0) { throw 'Candidate capture failed' }
} finally {
  [IO.File]::WriteAllText($materialPath, $candidate, $utf8)
  $env:WORLD_FIXED_DPR = $priorDpr
  $env:WORLD_WARMUP_MS = $priorWarmup
  Pop-Location
}
