@echo off
chcp 65001 >nul
title Sports Score - Stop
cd /d "%~dp0"

echo.
echo   Stopping the sports score system ...
echo.

rem ---------------------------------------------------------------------------
rem  How stopping works - deliberately kept dumb:
rem
rem    The server writes  data\stop-server.bat  when it starts. That file has
rem    this run's PID baked into a single taskkill line, so stopping needs no
rem    parsing, no process search and no quoting games.
rem
rem    An earlier version searched for node.exe processes whose command line
rem    contained "server.js" plus this folder path. That looked clever and
rem    failed in practice: cmd quoting plus backslashes plus a Chinese folder
rem    name meant the match missed, the script printed "Done", and the server
rem    kept holding the port.
rem
rem    If the file is missing the server simply is not running.
rem ---------------------------------------------------------------------------

set "STOPBAT=%~dp0data\stop-server.bat"

if exist "%STOPBAT%" (
  call "%STOPBAT%"
) else (
  echo   Not running - nothing to stop.
  echo   If a black window is still open, just close it with the X.
)

rem clean up the marker files so the next stop does not chase a dead PID
if exist "%STOPBAT%" del "%STOPBAT%" >nul 2>&1
if exist "%~dp0data\server.pid" del "%~dp0data\server.pid" >nul 2>&1

echo.
echo   Done. The port is free again.
echo.
timeout /t 3 /nobreak >nul 2>&1 && pause
