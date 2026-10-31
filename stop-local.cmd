@echo off
rem Billing Expo - stops the app safely (the database is closed cleanly). The Cloudflare Tunnel service keeps running:
rem it is shared with LR Fleet and simply has nothing to show for billing until run-local.cmd is started again.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1"
echo.
pause
