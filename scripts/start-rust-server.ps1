[CmdletBinding()]
param(
  [int]$DatabasePort = 55432,
  [int]$ApiPort = 8080,
  [string]$AppOrigin = 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pg = 'C:\Program Files\PostgreSQL\18\bin'
$cluster = Join-Path $projectRoot 'data/local/postgres-server'
if (-not (Test-Path (Join-Path $pg 'pg_ctl.exe'))) { throw 'PostgreSQL 18 is required. Set DATABASE_URL and use pnpm start for an existing database.' }
if (-not (Test-Path (Join-Path $cluster 'PG_VERSION'))) {
  & (Join-Path $pg 'initdb.exe') -D $cluster -U choketmon --auth=trust --encoding=UTF8 --no-locale
  if ($LASTEXITCODE -ne 0) { throw 'Isolated development cluster initialization failed.' }
}
& (Join-Path $pg 'pg_ctl.exe') -D $cluster status | Out-Null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pg 'pg_ctl.exe') -D $cluster -l (Join-Path $cluster 'server.log') -o "-p $DatabasePort -h 127.0.0.1" -w start
  if ($LASTEXITCODE -ne 0) { throw 'Development database startup failed.' }
}
$exists = & (Join-Path $pg 'psql.exe') -h 127.0.0.1 -p $DatabasePort -U choketmon -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='choketmon'"
if ($LASTEXITCODE -ne 0) { throw 'Cannot connect to the isolated development database.' }
if ($exists -ne '1') { & (Join-Path $pg 'createdb.exe') -h 127.0.0.1 -p $DatabasePort -U choketmon choketmon }
$env:DATABASE_URL = "postgres://choketmon@127.0.0.1:$DatabasePort/choketmon?sslmode=disable"
$env:CONNECTOME_DIR = Join-Path $projectRoot 'data/local/malecns-neurons166k'
$env:LISTEN_ADDR = "127.0.0.1:$ApiPort"
$env:APP_ORIGIN = $AppOrigin
$env:COOKIE_SECURE = 'false'
$env:RUST_LOG = 'info'
$env:RAYON_NUM_THREADS = '4'
Set-Location $projectRoot
& cargo run --release --manifest-path rust-server/Cargo.toml
