@echo off
chcp 65001 >nul
title Sports Score - Reset Password
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
set "NODE_OPTIONS=--no-warnings"

echo.
echo   ============================================
echo     Sports Score - Reset Password
echo   ============================================
echo.
echo   Type the account name, then the new password twice.
echo   The new password is shown at the end of this window,
echo   and also saved to a text file in this folder so you
echo   can look it up again later  (the exact file name is
echo   printed at the end of the run).
echo.

rem The Node tool does everything: lists the accounts, then asks for the account
rem name and the new password. Keeping the questions inside Node (instead of using
rem cmd's SET /P here) is deliberate - SET /P often reads nothing when input comes
rem from a pipe or a redirect, while Node's readline handles console, pipe and
rem redirect all the same way.
"%NODE%" --no-warnings "%~dp0tools\reset-password.js"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [X] Did not finish normally. Read the message above.
  echo       If it says the account was not found, check the spelling
  echo       against the account list printed above.
  echo       The password must be at least 6 characters and must not
  echo       be all digits.
  echo.
)

rem Pause only when somebody is sitting in front of a real console.
rem TIMEOUT fails immediately when stdin is a pipe/redirect, and in that case
rem waiting for a key press would hang forever.
timeout /t 3 /nobreak >nul 2>&1 && pause
exit /b %RC%
