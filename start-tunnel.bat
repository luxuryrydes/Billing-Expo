@echo off
rem Publishes the running app through a Cloudflare Tunnel.
rem Put the tunnel token in .env as CLOUDFLARE_TUNNEL_TOKEN=... (never commit it), start the app with start-windows.bat,
rem then run this file. If you already installed cloudflared as a Windows service, you do not need this file.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "TOKEN="
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="CLOUDFLARE_TUNNEL_TOKEN" set "TOKEN=%%b"
  )
)
if not defined TOKEN (
  echo CLOUDFLARE_TUNNEL_TOKEN is missing in .env
  pause
  exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed. Get it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  pause
  exit /b 1
)
cloudflared tunnel run --token !TOKEN!
