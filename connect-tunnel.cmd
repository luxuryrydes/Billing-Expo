@echo off
rem Connects this PC to Cloudflare so https://billing.lrbilling.in reaches the billing app on port 4000.
rem Run it once (right-click -> Run as administrator). The token comes from .env (CLOUDFLARE_TUNNEL_TOKEN) or is pasted when asked,
rem and is never saved by this file. If the cloudflared service is already running, the PC is already connected.
setlocal EnableDelayedExpansion
title LR Billing - Connect Cloudflare Tunnel
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed. Download the Windows installer from
  echo https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo and run it, then run this file again.
  pause
  exit /b 1
)

sc query cloudflared 2>nul | find "RUNNING" >nul
if not errorlevel 1 (
  echo The Cloudflare tunnel service is already running: this PC is connected.
  echo In Cloudflare, make sure the tunnel has a route: billing.lrbilling.in  ->  http://localhost:4000
  goto :check
)

net session >nul 2>nul
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

set "TOKEN="
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="CLOUDFLARE_TUNNEL_TOKEN" set "TOKEN=%%b"
  )
)
if not defined TOKEN set /p "TOKEN=Paste the tunnel token (the long text after 'service install'): "
if not defined TOKEN (
  echo No token given.
  pause
  exit /b 1
)

echo Installing the tunnel as a Windows service...
cloudflared service install !TOKEN!
if errorlevel 1 (
  echo The service could not be installed. If an old one exists, run:  cloudflared service uninstall   then try again.
  pause
  exit /b 1
)
echo Installed. It starts automatically with Windows.

:check
echo.
echo Checking the billing app on this PC...
curl -s -o nul -w "Billing app on port 4000: HTTP %%{http_code}\n" http://127.0.0.1:4000/ || echo Billing app is not running. Start start-windows.bat.
echo.
echo When the route is saved in Cloudflare, open https://billing.lrbilling.in
pause
