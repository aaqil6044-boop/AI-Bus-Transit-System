@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "JAVA_EXE=C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe"
set "OTP_JAR=%PROJECT_ROOT%otp\otp-shaded-2.8.1.jar"

if not exist "%JAVA_EXE%" (
  echo Java 21 was not found at "%JAVA_EXE%".
  exit /b 1
)

if not exist "%OTP_JAR%" (
  echo OpenTripPlanner has not been downloaded yet.
  exit /b 1
)

if not exist "%PROJECT_ROOT%otp\southern-zone-latest.osm.pbf" (
  echo Southern India OpenStreetMap data has not been downloaded yet.
  exit /b 1
)

echo Opening the visible Bengaluru routing-graph builder...
echo Do not close the next window while it is building.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%build-otp-graph.ps1"
set "OTP_EXIT=%ERRORLEVEL%"

if not "%OTP_EXIT%"=="0" (
  echo.
  echo Graph build stopped with exit code %OTP_EXIT%.
  echo The error was also saved in otp\build-user.log.
  pause
  exit /b %OTP_EXIT%
)

echo Graph build completed successfully.
pause
endlocal
