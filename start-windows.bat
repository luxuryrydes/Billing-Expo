@echo off
rem LR Billing - first run installs everything, later runs just start the app.
rem Open http://localhost:4000 when it says "Server listening".
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example
)

if not exist node_modules (
  echo Installing packages - first run only, this takes a few minutes...
  call npm install || goto :fail
)

if not exist worker\.venv (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3.10+ not found: PDF and Excel document reading will be unavailable until it is installed.
  ) else (
    echo Setting up the document reader - first run only...
    python -m venv worker\.venv && worker\.venv\Scripts\python -m pip install -q -r worker\requirements.txt
  )
)

if not exist web\dist\index.html (
  echo Building the app - first run only...
  call npm run build || goto :fail
)
if not exist server\dist\index.js (
  call npm run build || goto :fail
)

echo.
echo Starting LR Billing on http://localhost:4000  (close this window to stop it)
start "" http://localhost:4000
call npm start
goto :eof

:fail
echo Setup failed - see the messages above.
pause
exit /b 1
