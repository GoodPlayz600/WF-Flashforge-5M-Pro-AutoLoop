@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Install Node.js 22 or newer from https://nodejs.org/en/download/ then run this launcher again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:5174/ in Chrome.
node server.mjs %*
if errorlevel 1 pause
