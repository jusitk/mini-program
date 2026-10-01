@echo off
chcp 65001 >nul
title Sports Score - Install Portable Node
cd /d "%~dp0"

if exist "%~dp0node\node.exe" (
  "%~dp0node\node.exe" -v
  echo   node\node.exe is already here - nothing to do.
  timeout /t 3 /nobreak >nul 2>&1 && pause
  exit /b 0
)

echo.
echo   Downloading a portable Node.js into this project's node\ folder
echo   (about 30 MB, needs internet just this once) ...
echo.

rem ---------------------------------------------------------------------------
rem  The work is in tools\install-node.ps1.
rem
rem  Why not inline PowerShell here (learned the hard way): a version list
rem  piped through Select-Object inside a .bat made the whole array collapse
rem  into one string, so the download URL came out malformed (HTTP 400), and
rem  cmd also mangled the quoting. -File avoids all of that, and keeps this
rem  file readable.
rem
rem  The messages printed here are English on purpose: this runs before Node
rem  exists, and the console code page is not known yet. The Chinese guidance
rem  appears later, from tools\deploy.js, once we have Node's UTF-8 output.
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-node.ps1"
set "RC=%ERRORLEVEL%"

if not exist "%~dp0node\node.exe" (
  echo.
  echo   [X] Could not install a portable Node.js automatically.
  echo.
  echo   Do it by hand instead - about two minutes:
  echo     1. open https://nodejs.org in a browser
  echo     2. download the LTS Windows Installer, the .msi file
  echo     3. run it and click Next all the way
  echo     4. double-click the deploy file again
  echo.
  echo   If you already have node-vXX-win-x64.zip from another computer:
  echo     unpack it and put node.exe into this project's node\ folder.
  echo.
  timeout /t 5 /nobreak >nul 2>&1 && pause
  exit /b 1
)

"%~dp0node\node.exe" -v
echo   OK - portable Node.js is ready in node\
timeout /t 3 /nobreak >nul 2>&1 && pause
exit /b 0
