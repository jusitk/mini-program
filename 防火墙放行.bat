@echo off
chcp 65001 >nul
title Sports Score - Open Firewall
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Open the firewall for the web port so phones on the same Wi-Fi can connect.
rem
rem  THIS FILE NEEDS ADMIN RIGHTS. If it is not elevated the script still runs
rem  and prints the exact command to paste into an admin terminal, so the user
rem  is never stuck.
rem
rem  Right-click this file -^> "Run as administrator" for the one-click path.
rem ---------------------------------------------------------------------------

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   This needs administrator rights. Restarting elevated ...
  echo   click Yes in the Windows prompt that appears.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

set "NODE="
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%i"
  )
)
if not defined NODE (
  echo   [X] Node.js not found - run install-node.bat first.
  pause
  exit /b 1
)

"powershell" -NoProfile -ExecutionPolicy Bypass -Command "& '%NODE%' --no-warnings 'tools\deploy.js' --firewall-only --message='??????'"
timeout /t 5 /nobreak >nul 2>&1 && pause