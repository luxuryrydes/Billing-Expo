@echo off
rem ONE-TIME SETUP: connects this PC to your Cloudflare tunnel as the Windows service "cloudflared".
rem The service starts with Windows, reconnects by itself after an internet drop, and Windows restarts it if it stops.
rem One service serves every route on the tunnel (billing.lrbilling.in and fleet.lrbilling.in), so both apps share it.
rem If the service is already connected, nothing is changed unless you ask. To (re)install, paste the install command
rem Cloudflare shows (Tunnels -> your tunnel -> Configure -> Windows). The token is kept only in Windows' protected
rem service file (C:\ProgramData\cloudflared\token), never in this project, and is never printed.
setlocal
title Billing Expo - Connect Cloudflare Tunnel

net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "function Conns { $svcPid = (Get-CimInstance Win32_Service -Filter \"Name='cloudflared'\").ProcessId; if (-not $svcPid) { return 0 }; foreach ($p in (Get-NetTCPConnection -State Listen -OwningProcess $svcPid -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 20241 -and $_.LocalPort -le 20245 }).LocalPort) { try { return [int](Invoke-RestMethod \"http://127.0.0.1:$p/ready\" -TimeoutSec 3).readyConnections } catch {} }; return 0 };" ^
  "$exe = 'C:\Cloudflared\bin\cloudflared.exe';" ^
  "if (-not (Test-Path $exe)) { $c = Get-Command cloudflared -ErrorAction SilentlyContinue; if ($c) { $exe = $c.Source } };" ^
  "if (-not (Test-Path $exe)) { Write-Host 'cloudflared is not installed. Install it with:  winget install --id Cloudflare.cloudflared  then run this again.' -ForegroundColor Red; exit 1 };" ^
  "$svc = Get-Service cloudflared -ErrorAction SilentlyContinue;" ^
  "if ($svc -and $svc.Status -eq 'Running' -and (Conns) -gt 0) { Write-Host 'The Cloudflare Tunnel service is already running and connected. Nothing needs to change.' -ForegroundColor Green; if ((Read-Host 'Replace its token anyway? (y/N)') -notmatch '^[yY]') { sc.exe failure cloudflared reset= 86400 actions= restart/10000/restart/10000/restart/60000 | Out-Null; Write-Host 'Kept as it is (Windows will restart it if it ever stops).'; exit 0 } };" ^
  "Write-Host 'Cloudflare dashboard -> Zero Trust -> Networks -> Tunnels -> your tunnel -> Configure -> Windows.';" ^
  "Write-Host 'Copy the command shown there and paste it here (right-click pastes), then press Enter.';" ^
  "$line = Read-Host 'Paste';" ^
  "$tok = ($line -split '\s+' | Where-Object { $_ -like 'eyJ*' } | Select-Object -First 1);" ^
  "if (-not $tok) { Write-Host 'No token found in what you pasted (it starts with eyJ). Nothing was changed.' -ForegroundColor Red; exit 1 };" ^
  "try { $info = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($tok.PadRight([Math]::Ceiling($tok.Length / 4) * 4, '='))) | ConvertFrom-Json; Write-Host ('Tunnel id: ' + $info.t) } catch {};" ^
  "$log = Join-Path $env:TEMP 'cloudflared-install.log';" ^
  "if ($svc) { Write-Host 'Removing the old connector service...'; Start-Process $exe -ArgumentList 'service','uninstall' -Wait -NoNewWindow -RedirectStandardError $log; Start-Sleep 3 };" ^
  "Write-Host 'Installing the connector service...';" ^
  "Start-Process $exe -ArgumentList 'service','install',$tok -Wait -NoNewWindow -RedirectStandardError $log;" ^
  "sc.exe config cloudflared start= auto | Out-Null;" ^
  "sc.exe failure cloudflared reset= 86400 actions= restart/10000/restart/10000/restart/60000 | Out-Null;" ^
  "for ($i = 0; $i -lt 15; $i++) { $svc = Get-Service cloudflared -ErrorAction SilentlyContinue; if ($svc -and $svc.Status -ne 'Running') { Start-Service cloudflared -ErrorAction SilentlyContinue }; if ($svc -and $svc.Status -eq 'Running') { break }; Start-Sleep 2 };" ^
  "if (-not $svc -or $svc.Status -ne 'Running') { Write-Host ('The service did not start. Details: ' + $log) -ForegroundColor Red; exit 1 };" ^
  "$n = 0; for ($i = 0; $i -lt 15 -and $n -lt 1; $i++) { Start-Sleep 2; $n = Conns };" ^
  "if ($n -gt 0) { Write-Host ('Connected to Cloudflare (' + $n + ' connections). In Cloudflare the tunnel now shows HEALTHY.') -ForegroundColor Green } else { Write-Host 'Service running but not connected. If the tunnel stays DOWN in Cloudflare, the token is from a deleted tunnel: copy a fresh one.' -ForegroundColor Yellow };" ^
  "Write-Host 'The tunnel needs one route per address:  billing.lrbilling.in -> http://localhost:4000   and   fleet.lrbilling.in -> http://localhost:4173'"
echo.
pause
