@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, including npm:
  echo https://nodejs.org/en/download
  echo Then close and reopen this launcher.
  pause
  exit /b 1
)
node scripts\local.mjs
if errorlevel 1 (
  echo.
  echo Startup failed. Please keep the error message above for troubleshooting.
  pause
  exit /b 1
)
endlocal
