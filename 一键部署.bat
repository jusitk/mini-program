@echo off
chcp 65001 >nul
title Sports Score - Deploy
cd /d "%~dp0"

echo.
echo   ============================================================
echo     Sports Score System   -   one click deploy
echo   ============================================================
echo.
echo   Steps: find Node.js (download a portable copy if missing),
echo          check files / port / data folder, open the firewall
echo          (needs admin), start the server, show the addresses.
echo.
echo   If Windows asks for administrator rights, click Yes.
echo   Without admin rights it still runs, but phones on the same
echo   Wi-Fi may not be able to connect.
echo.

rem ---- 1. which Node? ---------------------------------------------------
rem   a) the portable one in this project's node\ folder
rem   b) a normal installation found on PATH
set "NODE="
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%i"
  )
)

rem ---- 2. none found: fetch a portable one -----------------------------
rem   NOTE: the called file's name is pure ASCII on purpose. A .bat can
rem   reference non-ASCII filenames only sometimes - cmd parses the script
rem   bytes using the console code page, so "call <chinese>.bat" failed in
rem   testing (both with chcp 65001 and with a GBK-encoded .bat). ASCII
rem   names always work; the Chinese naming is kept for the files a human
rem   double-clicks.
if not defined NODE (
  call "%~dp0install-node.bat"
  if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
)

if not defined NODE (
  echo.
  echo   [X] No Node.js available.
  echo       Double-click  install-node.bat  and read what it prints,
  echo       or install Node.js 22.5 or newer from nodejs.org and try again.
  echo.
  timeout /t 5 /nobreak >nul 2>&1 && pause
  exit /b 1
)

rem ---- 3. hand over to the deploy tool ---------------------------------
rem   Checks, firewall, addresses and starting the server all live in
rem   tools\deploy.js. A real program beats a long .bat: it can be tested,
rem   and every message it prints is in proper Chinese.
"powershell" -NoProfile -ExecutionPolicy Bypass -Command "& '%NODE%' --no-warnings 'tools\deploy.js'"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [X] Deploy did not finish normally - read the messages above.
  echo.
)
rem Pause only with a real console attached: TIMEOUT fails on a pipe and
rem waiting for a key press would then hang forever.
timeout /t 3 /nobreak >nul 2>&1 && pause
exit /b %RC%
