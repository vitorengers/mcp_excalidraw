@echo off
rem VibeMaxxing - double-click to start the board. See docs/launchers.md.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
rem `call`, because npx is itself a .cmd: without it control never comes back here and the
rem window closes on whatever npx did.
call npx -y @vitorengers/vibemaxxing@latest
if errorlevel 1 pause
