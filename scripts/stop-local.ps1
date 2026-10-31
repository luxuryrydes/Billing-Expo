# Billing Expo - safe stop. Started by stop-local.cmd.
# Sends the server the same Ctrl+C that closing its window would, so it closes the embedded database cleanly, then
# waits for it to exit. It never force-kills the server (that can damage data\pglite). The Cloudflare Tunnel service is
# left running: it is shared with other apps on this PC.
$root = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runLog = Join-Path $logDir 'run-local.log'
function Say([string]$m = '') { Write-Host $m; try { Add-Content -Path $runLog -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) } catch { } }

$port = 4000
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) { foreach ($l in Get-Content $envFile) { if ($l -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] } } }
if ($env:PORT) { $port = [int]$env:PORT }

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { Say "Billing Expo is not running (nothing on port $port)."; exit 0 }
$server = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if (-not $server -or $server.Name -ne 'node.exe' -or $server.CommandLine -notmatch 'server[\\/]dist[\\/]index\.js') {
  Say "Port $port is used by '$($server.Name)' (process $($listener.OwningProcess)), which is not Billing Expo. Nothing was stopped."
  exit 1
}
$serverPid = [int]$server.ProcessId
Say "Stopping Billing Expo (process $serverPid) and closing the database..."

# A separate hidden PowerShell attaches to the server's console and sends Ctrl+C there (this window keeps its own console).
$ctrlC = @"
Add-Type -Name K -Namespace W -MemberDefinition '
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'
[W.K]::FreeConsole() | Out-Null
if (-not [W.K]::AttachConsole($serverPid)) { exit 3 }
[W.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, `$true) | Out-Null
[W.K]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
Start-Sleep -Milliseconds 500
exit 0
"@
$helper = Start-Process powershell -ArgumentList '-NoProfile', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ctrlC))) -WindowStyle Hidden -Wait -PassThru
if ($helper.ExitCode -eq 3) { Say 'The server has no window to send the stop signal to. Close its window, or restart Windows; it was not force-stopped.'; exit 1 }

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Process -Id $serverPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
  Say 'The server is still closing the database after 30 seconds. It was NOT forced to stop; give it a minute, then run this again.'
  exit 1
}

# The server is gone, so its start window has nothing left to protect: close it if it is waiting on a prompt.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' or Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'run-local\.(cmd|ps1)' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Say 'Billing Expo stopped. The database was closed safely.'
