@echo off
setlocal
title Club CS - Local Demo

rem ===== Switch to the script directory (project root) =====
cd /d "%~dp0"

rem ===== Check Node.js =====
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 16+ first: https://nodejs.org/
  pause
  exit /b 1
)

rem ===== Demo port. Override with env var DEMO_PORT, default 8787 =====
if not defined DEMO_PORT set "DEMO_PORT=8787"

rem ===== If the port is already in use, just open the browser =====
netstat -ano | findstr /c:":%DEMO_PORT% " | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [INFO] Port %DEMO_PORT% is already in use. Demo server seems running. Opening browser...
  start "" "http://localhost:%DEMO_PORT%"
  timeout /t 3 /nobreak >nul
  exit /b 0
)

echo ==========================================
echo   Club CS - Local Demo starting...
echo   URL: http://localhost:%DEMO_PORT%
echo   Custom port: set DEMO_PORT=9000 then rerun
echo   Stop: close this window or press Ctrl+C
echo ==========================================
echo.

rem ===== Open browser automatically once the server is ready =====
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%DEMO_PORT%"

rem ===== Start the demo server in the foreground =====
node demo\server.mjs

echo.
echo [INFO] Demo server exited.
pause
