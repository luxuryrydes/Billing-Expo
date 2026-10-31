@echo off
rem Billing Expo - one-click start. Double-click this file; all the work is done by scripts\run-local.ps1.
title Billing Expo
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-local.ps1" %*
if errorlevel 1 (
  echo.
  echo Billing Expo could not start. Read the message above, or logs\run-local.log.
  pause
)
