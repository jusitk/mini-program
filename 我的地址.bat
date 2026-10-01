@echo off
chcp 65001 >nul
title Sports Score - My Address
cd /d "%~dp0"

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

rem Chinese output comes from tools\my-ip.js (UTF-8), not from this file.
"powershell" -NoProfile -ExecutionPolicy Bypass -Command "& '%NODE%' --no-warnings 'tools\my-ip.js'"
timeout /t 20 /nobreak >nul 2>&1 && pause