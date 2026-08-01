# Local development database.
#
# A portable PostgreSQL 17 under %LOCALAPPDATA%\dnc-postgres — not a Windows service, not
# installed system-wide, no elevation required. Nothing runs until you start it, and
# deleting that folder removes it completely.
#
#   .\scripts\dev-db.ps1 start
#   .\scripts\dev-db.ps1 stop
#   .\scripts\dev-db.ps1 status
#   .\scripts\dev-db.ps1 psql
#
# Connection strings live in app/.env, which is gitignored. The password here is a
# local-development value with no production equivalent.

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'psql', 'logs')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'dnc-postgres'
$Bin = Join-Path $Root 'pgsql\bin'
$Data = Join-Path $Root 'data'
$Log = Join-Path $Root 'pg.log'
$Port = 5433

if (-not (Test-Path $Bin)) {
    Write-Host "PostgreSQL not found at $Root." -ForegroundColor Red
    Write-Host "See docs/05-stack.md for how the local cluster is provisioned."
    exit 1
}

switch ($Command) {
    'start' {
        # Launched detached on purpose.
        #
        # Calling pg_ctl directly leaves postgres holding the console's stdout handle, so
        # the calling shell never returns even though the server is up — which looks
        # exactly like a hang. Start-Process with redirected output breaks that
        # inheritance, and we then poll for readiness ourselves.
        Start-Process -FilePath "$Bin\pg_ctl.exe" `
            -ArgumentList @('-D', "`"$Data`"", '-l', "`"$Log`"", '-o', "`"-p $Port`"", 'start') `
            -WindowStyle Hidden `
            -RedirectStandardOutput "$Root\pg_ctl.out" `
            -RedirectStandardError "$Root\pg_ctl.err"

        for ($i = 0; $i -lt 30; $i++) {
            & "$Bin\pg_isready.exe" -h 127.0.0.1 -p $Port -q
            if ($LASTEXITCODE -eq 0) { Write-Host "postgres ready on port $Port"; exit 0 }
            Start-Sleep -Milliseconds 400
        }

        Write-Host "postgres did not become ready in 12s. Last log lines:" -ForegroundColor Red
        if (Test-Path $Log) { Get-Content $Log -Tail 20 }
        exit 1
    }
    'stop' {
        & "$Bin\pg_ctl.exe" -D $Data -m fast -w stop
    }
    'status' {
        & "$Bin\pg_isready.exe" -h 127.0.0.1 -p $Port
    }
    'psql' {
        $env:PGPASSWORD = 'devonly_localpg'
        & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d dnc_dev
    }
    'logs' {
        if (Test-Path $Log) { Get-Content $Log -Tail 40 } else { Write-Host 'No log yet.' }
    }
}
