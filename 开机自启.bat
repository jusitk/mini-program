@echo off
chcp 65001 >nul
title Sports Score - Autostart On/Off
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Turn "start automatically after Windows logon" ON or OFF.
rem  Running this file toggles: first run turns it on, running it again turns
rem  it off. The tool prints which one just happened, in Chinese.
rem
rem  It only touches a .bat inside the CURRENT USER's Startup folder - no
rem  registry, no scheduled task, no admin rights. The user can also just
rem  delete that file by hand.
rem ---------------------------------------------------------------------------

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

"powershell" -NoProfile -ExecutionPolicy Bypass -Command "& '%NODE%' --no-warnings 'tools\deploy.js' --autostart --message='??/??????'"
timeout /t 8 /nobreak >nul 2>&1 && pause