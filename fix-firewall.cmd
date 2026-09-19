@echo off
rem Allow the Expo/Metro dev server through Windows Firewall (port 8081).
rem
rem RIGHT-CLICK THIS FILE -> "Run as administrator".
rem
rem Why: Windows blocks inbound connections by default. Without a rule, your
rem phone scans the QR, Expo Go tries to reach http://<your-lan-ip>:8081 and
rem times out ("The request timed out"). This adds one inbound TCP rule.
rem
rem ASCII-only on purpose: cmd.exe reads .cmd in the OEM code page, so non-ASCII
rem comments can be mis-decoded into stray commands.

setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [!] Not running as administrator.
  echo     Close this window, right-click fix-firewall.cmd, choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo [1/2] adding inbound rule for TCP 8081 ...
netsh advfirewall firewall delete rule name="Expo Metro (Node) 8081" >nul 2>&1
netsh advfirewall firewall add rule name="Expo Metro (Node) 8081" dir=in action=allow protocol=TCP localport=8081 profile=private,domain
if errorlevel 1 (
  echo [!] failed to add the rule
  pause
  exit /b 1
)

echo.
echo [2/2] current rule:
netsh advfirewall firewall show rule name="Expo Metro (Node) 8081" | findstr /i "Rule Name Enabled Action Direction LocalPort"
echo.
echo Done. Now run  start.cmd  again and scan the QR from inside Expo Go.
echo If it still times out: make sure the phone is on the same WiFi as this PC.
echo.
pause
endlocal
