# Billing Expo - one-click start. Started by run-local.cmd.
#  1. checks the project   2. starts (or reuses) the backend   3. checks the website it serves
#  4. checks the Cloudflare Tunnel service (starts it if stopped)   5. confirms the public address answers.
# No token or credential is read, stored or printed here: the tunnel runs as a Windows service that was set up once
# with connect-tunnel.cmd, and its credentials stay in Windows, outside this project.
param([switch]$NoTunnel, [int]$MaxRestarts = 3)
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runLog = Join-Path $logDir 'run-local.log'

function Say([string]$m = '') { Write-Host $m; try { Add-Content -Path $runLog -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) } catch { } }
function Stop-Here([string]$m) { Say ''; Say "ERROR: $m"; Say ''; exit 1 }
function Tail([string]$file, [int]$n = 12) { if (Test-Path $file) { (Get-Content $file -Tail $n) -join "`n" } else { '' } }
function Probe([string]$url, [int]$sec = 6) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $sec; return @{ ok = $true; code = [int]$r.StatusCode; body = [string]$r.Content } }
  catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    return @{ ok = $false; code = $code; body = '' }
  }
}
function ReadEnv {
  $h = @{}
  $f = Join-Path $root '.env'
  if (Test-Path $f) { foreach ($l in Get-Content $f) { if ($l -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $l.TrimStart().StartsWith('#')) { $h[$Matches[1]] = $Matches[2].Trim('"') } } }
  return $h
}

Say '=========================================='
Say ' BILLING EXPO - STARTUP'
Say '=========================================='

# ---- [1/5] project configuration ------------------------------------------------------------------------------------
Say '[1/5] Checking project configuration...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Stop-Here 'Node.js 20 or newer is not installed. Install it from https://nodejs.org and run this again.' }
$ver = [version](((& node --version) -replace '^v', '') -replace '^(\d+\.\d+\.\d+).*$', '$1')
if ($ver.Major -lt 20) { Stop-Here "Node.js $ver is too old; version 20 or newer is needed." }
if (-not (Test-Path (Join-Path $root '.env'))) {
  if (Test-Path (Join-Path $root '.env.example')) { Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env'); Say '      Created .env from .env.example (your settings file).' }
  else { Stop-Here '.env is missing and there is no .env.example to copy.' }
}
$cfg = ReadEnv
$port = if ($env:PORT) { [int]$env:PORT } elseif ($cfg['PORT']) { [int]$cfg['PORT'] } else { 4000 }
$public = $(if ($env:PUBLIC_URL) { $env:PUBLIC_URL } else { $cfg['PUBLIC_URL'] + '' }).TrimEnd('/')
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '      Installing packages (first run only, a few minutes)...'
  & npm install *>> (Join-Path $logDir 'build.log'); if ($LASTEXITCODE -ne 0) { Stop-Here "npm install failed. See $logDir\build.log" }
}
function Newest($dir) { $f = Get-ChildItem -Path $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { $f.LastWriteTime } else { [datetime]::MinValue } }
$srvDist = Join-Path $root 'server\dist\index.js'
$webDist = Join-Path $root 'web\dist\index.html'
$stale = (-not (Test-Path $srvDist)) -or (-not (Test-Path $webDist)) -or
  ((Newest (Join-Path $root 'server\src')) -gt (Get-Item $srvDist -ErrorAction SilentlyContinue).LastWriteTime) -or
  ((Newest (Join-Path $root 'web\src')) -gt (Get-Item $webDist -ErrorAction SilentlyContinue).LastWriteTime)
$health = Probe "http://127.0.0.1:$port/api/health" 3
if ($stale -and -not $health.ok) {
  Say '      Building the app (files changed since the last build)...'
  & npm run build *>> (Join-Path $logDir 'build.log'); if ($LASTEXITCODE -ne 0) { Stop-Here "The build failed. See $logDir\build.log" }
} elseif ($stale) { Say '      Note: the app is already running; the newest build will be used the next time it is started.' }
if (-not (Test-Path (Join-Path $root 'worker\.venv'))) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if ($py) {
    Say '      Setting up the PDF/Excel document reader (first run only)...'
    & $py.Source -m venv (Join-Path $root 'worker\.venv') *>> (Join-Path $logDir 'build.log')
    & (Join-Path $root 'worker\.venv\Scripts\python.exe') -m pip install -q -r (Join-Path $root 'worker\requirements.txt') *>> (Join-Path $logDir 'build.log')
    if ($LASTEXITCODE -ne 0) { Say "      Note: the document reader could not be installed (see $logDiruild.log); everything else works." }
  } else { Say '      Note: Python 3.10+ is not installed, so PDF/Excel document reading is unavailable; everything else works.' }
}

# ---- [2/5] backend --------------------------------------------------------------------------------------------------
Say '[2/5] Starting backend...'
$proc = $null
$reused = $false
$serverLog = Join-Path $logDir 'server.log'
$serverErr = Join-Path $logDir 'server-error.log'
function Start-Server {
  foreach ($f in $serverLog, $serverErr) { if ((Test-Path $f) -and (Get-Item $f).Length -gt 5MB) { Move-Item -Force $f "$f.old" } }
  Add-Content -Path $serverLog -Value ("`n==== {0:yyyy-MM-dd HH:mm:ss} start ====" -f (Get-Date))
  # Same console window, so Ctrl+C or closing this window shuts the database down cleanly.
  $p = Start-Process -FilePath $node.Source -ArgumentList 'server/dist/index.js' -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
  $null = $p.Handle   # keeps the handle open so the exit code can be read after the process stops
  return $p
}
function Wait-Healthy([int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if ((Probe "http://127.0.0.1:$port/api/health" 3).ok) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
if ($health.ok) {
  $reused = $true
  Say "      Already running on port $port - reusing it (no second copy is started)."
} else {
  $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($owner) {
    $p = Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue
    Stop-Here ("Port $port is in use by '{0}' (process {1}) and it is not Billing Expo. Close that program, or set a different PORT in .env, then run this again. Nothing was stopped." -f $(if ($p) { $p.ProcessName } else { 'unknown' }), $owner.OwningProcess)
  }
  $proc = Start-Server
  if (-not (Wait-Healthy 90)) {
    $why = (Tail $serverErr) + "`n" + (Tail $serverLog)
    $hint = 'See logs\server-error.log.'
    if ($why -match 'Aborted\(\)|could not open file|database could not be opened') { $hint = 'The database could not be opened. Another copy of the app may be using it, or data\pglite is damaged: see "Protecting the data" in README.md to restore the newest data\backups\auto-... copy.' }
    Stop-Here "The backend did not become ready. $hint`n$why"
  }
  Say "      Backend started (process $($proc.Id)), log: logs\server.log"
}

# ---- [3/5] frontend ---------------------------------------------------------------------------------------------------
Say '[3/5] Checking the website...'
$page = Probe "http://127.0.0.1:$port/" 8
$frontOk = $page.ok -and ($page.body -match '<div id="root"')
if (-not $frontOk) { Stop-Here "The website did not load from http://127.0.0.1:$port/ (HTTP $($page.code)). Run:  npm run build  and start again." }
Say '      The website is served by the backend on the same port (no separate frontend process is needed).'

# ---- [4/5] Cloudflare Tunnel ----------------------------------------------------------------------------------------
Say '[4/5] Checking Cloudflare Tunnel...'
$tunnel = 'NOT CHECKED'
function Get-TunnelService { Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue }
function Get-TunnelConnections {
  # cloudflared reports its live connections to Cloudflare on a local status page (ports 20241-20245).
  $svcPid = (Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue).ProcessId
  if (-not $svcPid) { return -1 }
  $ports = Get-NetTCPConnection -State Listen -OwningProcess $svcPid -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 20241 -and $_.LocalPort -le 20245 } | ForEach-Object LocalPort
  foreach ($p in $ports) {
    try { return [int](Invoke-RestMethod -Uri "http://127.0.0.1:$p/ready" -TimeoutSec 3).readyConnections } catch {
      try { return [int](($_.ErrorDetails.Message | ConvertFrom-Json).readyConnections) } catch { }
    }
  }
  return -1
}
function Ensure-Tunnel {
  $svc = Get-TunnelService
  if (-not $svc) { return 'NOT CONFIGURED' }
  if ($svc.Status -ne 'Running') {
    try { Start-Service -Name 'cloudflared' -ErrorAction Stop } catch {
      Say '      The tunnel service is stopped; asking Windows for permission to start it (one prompt)...'
      try { Start-Process -FilePath 'sc.exe' -ArgumentList 'start cloudflared' -Verb RunAs -Wait -WindowStyle Hidden } catch { }
    }
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if ((Get-TunnelService).Status -eq 'Running') { break } }
  }
  if ((Get-TunnelService).Status -eq 'Running') { return 'RUNNING' } else { return 'STOPPED' }
}
if ($NoTunnel -or -not $public) {
  $tunnel = 'SKIPPED'
  Say '      Skipped (no PUBLIC_URL in .env, or -NoTunnel).'
} else {
  $tunnel = Ensure-Tunnel
  switch ($tunnel) {
    'RUNNING' {
      $count = @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue).Count
      Say "      Cloudflare Tunnel service is running (reused, nothing new created)."
      $conns = -1
      for ($i = 0; $i -lt 15; $i++) { $conns = Get-TunnelConnections; if ($conns -gt 0) { break }; Start-Sleep -Seconds 2 }
      if ($conns -gt 0) { Say "      Connected to Cloudflare ($conns connections)." }
      elseif ($conns -eq 0) { Say '      Warning: the service is running but has no connection to Cloudflare. Check the internet; if it stays like this the tunnel token is from a deleted tunnel: run connect-tunnel.cmd with a fresh one.' }
      if ($count -gt 1) { Say "      Warning: $count cloudflared processes are running. Only the service is needed; close any extra ones (for example a hand-started quick tunnel)." }
      if ((Get-TunnelService).StartType -ne 'Automatic') { Say '      Note: the tunnel service does not start automatically with Windows. Run connect-tunnel.cmd as administrator once.' }
    }
    'NOT CONFIGURED' { Say '      The Cloudflare Tunnel service is not installed on this PC. One-time setup: right-click connect-tunnel.cmd and choose Run as administrator.' }
    'STOPPED' { Say '      The tunnel service could not be started. Open Services (services.msc), start "Cloudflare Tunnel" (cloudflared), or run connect-tunnel.cmd as administrator.' }
  }
}

# ---- [5/5] public address -----------------------------------------------------------------------------------------------
Say '[5/5] Verifying connection...'
$publicState = 'NOT CHECKED'
function Test-Public {
  $r = Probe "$public/api/health" 10
  if ($r.ok -and $r.body -match '"ok"\s*:\s*true') { return 'REACHABLE' }
  return "UNREACHABLE (HTTP $($r.code))"
}
if ($public -and $tunnel -ne 'SKIPPED') {
  $until = (Get-Date).AddSeconds(45)
  do { $publicState = Test-Public; if ($publicState -eq 'REACHABLE') { break }; Start-Sleep -Seconds 3 } while ((Get-Date) -lt $until)
}
$allGood = ($publicState -eq 'REACHABLE') -or ($tunnel -eq 'SKIPPED')

Say '=========================================='
if ($allGood) { Say ' BILLING EXPO IS RUNNING SUCCESSFULLY' } else { Say ' BILLING EXPO IS RUNNING LOCALLY - PUBLIC ADDRESS NOT REACHABLE' }
Say '=========================================='
Say "Local URL:          http://localhost:$port"
if ($public) { Say "Public URL:         $public" }
Say ("Cloudflare Tunnel:  {0}" -f $(if ($tunnel -eq 'RUNNING' -and $publicState -eq 'REACHABLE') { 'CONNECTED' } elseif ($tunnel -eq 'RUNNING') { 'SERVICE RUNNING, ROUTE NOT ANSWERING' } else { $tunnel }))
if ($public -and $tunnel -ne 'SKIPPED') { Say "Public address:     $publicState" }
Say 'Backend:            RUNNING'
Say 'Frontend:           RUNNING (served by the backend)'
if (-not $allGood -and $tunnel -eq 'RUNNING') {
  Say ''
  Say 'The tunnel is connected to Cloudflare but the public address does not reach this app. In Cloudflare check that:'
  Say "  - the tunnel has a route for the hostname above with service http://localhost:$port, and"
  Say '  - the DNS record for that hostname (CNAME) points at THIS tunnel: <tunnel-id>.cfargotunnel.com, Proxied.'
  Say 'Cloudflare error 1033 (HTTP 530) means the DNS record points at a tunnel that has no connector running.'
  Say "HTTP 502 means the route exists but points at the wrong address: it must be http://localhost:$port."

}
Say ''

if ($reused) { Say 'Billing Expo was already running, so nothing else was started. This window can be closed.'; Start-Sleep -Seconds 8; exit 0 }

Say 'Keep this window open while you use Billing Expo.'
Say 'To stop: press Ctrl+C, or close this window (the database is closed safely).'
Say ''

# ---- supervise: restart the backend if it stops, keep the tunnel service running -------------------------------------
$restarts = 0
$lastTunnelCheck = Get-Date
try {
  while ($true) {
    Start-Sleep -Seconds 5
    if ($proc.HasExited) {
      $code = $proc.ExitCode
      Say ("Backend stopped (exit code {0}). {1}" -f $code, (Tail $serverErr 6))
      if ($restarts -ge $MaxRestarts) { Stop-Here "The backend stopped $($restarts + 1) times. Not restarting again; see logs\server-error.log." }
      $restarts++
      Say "Restarting the backend ($restarts of $MaxRestarts)..."
      Start-Sleep -Seconds 3
      $proc = Start-Server
      if (-not (Wait-Healthy 90)) { Stop-Here 'The backend did not come back. See logs\server-error.log.' }
      Say 'Backend is running again.'
    }
    if (-not $NoTunnel -and $public -and ((Get-Date) - $lastTunnelCheck).TotalSeconds -ge 60) {
      $lastTunnelCheck = Get-Date
      $svc = Get-TunnelService
      if ($svc -and $svc.Status -ne 'Running') { Say 'The Cloudflare Tunnel service stopped; starting it again...'; $null = Ensure-Tunnel }
      if ($publicState -ne 'REACHABLE') { $publicState = Test-Public; if ($publicState -eq 'REACHABLE') { Say "Public address is now reachable: $public" } }
    }
  }
} finally {
  if ($proc -and -not $proc.HasExited) { $null = $proc.WaitForExit(15000) }
}
