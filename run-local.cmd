@echo off
setlocal

echo Starting Bengaluru Transit Assistant...
echo Keep this window open while using http://127.0.0.1:8765/
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1"

echo.
echo The server stopped. Press any key to close this window.
pause >nul
