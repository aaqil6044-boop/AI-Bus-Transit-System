@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "JAVA_EXE=C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe"
set "OTP_JAR=%PROJECT_ROOT%otp\otp-shaded-2.8.1.jar"

if not exist "%PROJECT_ROOT%otp\graph.obj" (
  echo Routing graph not found. Run build-otp-graph.cmd once first.
  exit /b 1
)

echo Starting the route engine at http://127.0.0.1:8766/
"%JAVA_EXE%" -Xmx4G -jar "%OTP_JAR%" --load --port 8766 --bindAddress 127.0.0.1 "%PROJECT_ROOT%otp"
pause
endlocal
