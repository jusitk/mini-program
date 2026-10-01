@echo off
chcp 65001 >nul
title Sports Score Server
cd /d "%~dp0"

set "NODE="
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%i"
  )
)
if not defined NODE (
  echo.
  echo   [X] Node.js not found.
  echo       Double-click  install-node.bat  first, or install Node 22.5+
  echo       from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

rem All Chinese messages come from tools\deploy.js. Writing Chinese directly in
rem a .bat is unreliable: cmd parses the script bytes using the console code
rem page, so it garbles depending on the machine. ASCII .bat + UTF-8 Node
rem output always renders correctly.
rem
rem --quick skips the deploy-only checks (file list, firewall) so a normal start
rem is fast; it still verifies Node, the port and the data folder, prints the
rem addresses, then starts the server.
"powershell" -NoProfile -ExecutionPolicy Bypass -Command "& '%NODE%' --no-warnings 'tools\deploy.js' --quick"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   [X] The server stopped. Read the messages above.
  echo       Common causes:
  echo         1. the port is already used   - change "port" in config.js
  echo         2. the data folder is locked  - move this folder to D:\ or F:\
  echo         3. Node.js is older than 22.5 - install a newer one
  echo.
)
timeout /t 3 /nobreak >nul 2>&1 && pause
exit /b %RC%