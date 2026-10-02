<#
  Local PostgreSQL for development without Docker or admin rights.
  Binaries: %LOCALAPPDATA%\Programs\pgsql (EDB portable build, with app-local VC++ runtime DLLs).
  Data:     %LOCALAPPDATA%\workeasy\pgdata (deliberately outside OneDrive).

  Usage:  powershell -File scripts/local-postgres.ps1 init|start|stop|status
  `init` creates the cluster with a random superuser password and writes DATABASE_ADMIN_URL to .env.
#>
param([Parameter(Mandatory)][ValidateSet('init', 'start', 'stop', 'status')][string]$Command)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:LOCALAPPDATA 'Programs\pgsql\bin'
$root = Join-Path $env:LOCALAPPDATA 'workeasy'
$data = Join-Path $root 'pgdata'
$log = Join-Path $root 'postgres.log'
$envFile = Join-Path $PSScriptRoot '..\.env'

function Start-Detached([string[]]$ArgList) {
  # pg_ctl's child postgres would inherit redirected handles, and `Start-Process -Wait` waits for the whole
  # process tree (including the server). Wait on pg_ctl itself only.
  $p = Start-Process -FilePath (Join-Path $bin 'pg_ctl.exe') -ArgumentList $ArgList -WindowStyle Hidden -PassThru
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "pg_ctl $($ArgList[0]) failed with exit code $($p.ExitCode); see $log" }
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
  $lines = @($lines | Where-Object { $_ -notmatch "^$Key=" }) + "$Key=$Value"
  [IO.File]::WriteAllLines((Resolve-Path -LiteralPath (Split-Path $envFile) | Join-Path -ChildPath '.env'), $lines)
}

switch ($Command) {
  'init' {
    if (Test-Path $data) { throw "Cluster already exists at $data" }
    New-Item -ItemType Directory -Force $root | Out-Null
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = ([Convert]::ToBase64String($bytes)) -replace '[+/=]', ''
    Set-EnvValue 'DATABASE_ADMIN_URL' "postgresql://postgres:$pw@localhost:5432/postgres"
    $pwFile = Join-Path $root 'init.pw'
    [IO.File]::WriteAllText($pwFile, $pw)
    try {
      & (Join-Path $bin 'initdb.exe') -D $data -U postgres "--pwfile=$pwFile" --auth=scram-sha-256 --encoding=UTF8 --locale=C | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
    } finally { Remove-Item $pwFile -ErrorAction SilentlyContinue }
    Add-Content (Join-Path $data 'postgresql.conf') "`nlisten_addresses = 'localhost'`nport = 5432`nlog_min_duration_statement = 500"
    Start-Detached @('start', '-D', "`"$data`"", '-l', "`"$log`"", '-w')
    Write-Output "Initialized and started. Superuser URL written to .env as DATABASE_ADMIN_URL."
  }
  'start' { Start-Detached @('start', '-D', "`"$data`"", '-l', "`"$log`"", '-w'); Write-Output 'started' }
  'stop' { Start-Detached @('stop', '-D', "`"$data`"", '-m', 'fast', '-w'); Write-Output 'stopped' }
  'status' { & (Join-Path $bin 'pg_ctl.exe') status -D $data }
}
