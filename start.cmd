@echo off
rem One-click launcher for the DSH-iOS dev server.
rem
rem Why this file exists: PowerShell blocks .ps1 scripts by default (execution policy),
rem so `npx expo start` fails with "cannot load file npx.ps1".
rem Going through the .cmd shim avoids that without changing any system setting.
rem
rem NOTE: this file is deliberately ASCII-only. cmd.exe reads .cmd files in the OEM
rem code page, so non-ASCII comments get mis-decoded and their bytes can be parsed as
rem stray commands (you would see noise like "'d' is not recognized").
rem
rem Usage: double-click this file, or run  start.cmd  in any terminal.

setlocal
cd /d "%~dp0"
echo [DSH-iOS] starting Metro (dev server)...
echo [DSH-iOS] install Expo Go from the App Store on your iPhone, then scan the QR below.
echo.
call npx.cmd expo start %*
endlocal
