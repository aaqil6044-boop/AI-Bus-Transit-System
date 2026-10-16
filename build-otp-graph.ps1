$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$javaExe = "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe"
$otpJar = Join-Path $projectRoot "otp\otp-shaded-2.8.1.jar"
$otpDirectory = Join-Path $projectRoot "otp"
$osmFile = Join-Path $otpDirectory "bengaluru.osm.pbf"
$logFile = Join-Path $otpDirectory "build-user.log"

if (-not (Test-Path -LiteralPath $javaExe)) { throw "Java 21 was not found: $javaExe" }
if (-not (Test-Path -LiteralPath $otpJar)) { throw "OpenTripPlanner was not found: $otpJar" }
if (-not (Test-Path -LiteralPath $osmFile)) {
    $pythonExe = "C:\Users\aaqil\AppData\Local\Programs\Python\Python312\python.exe"
    & $pythonExe -u (Join-Path $otpDirectory "extract_bengaluru.py")
    if ($LASTEXITCODE -ne 0) { throw "City-map extraction failed." }
}

Write-Host ""
Write-Host "Building the Bengaluru transit graph..." -ForegroundColor Cyan
Write-Host "Progress is shown below. This can take several minutes." -ForegroundColor Yellow
Write-Host "Log file: $logFile" -ForegroundColor DarkGray
Write-Host ""

# Windows PowerShell turns native stderr into error records. Keep recording
# those records so a Java diagnostic does not terminate the log pipeline.
$ErrorActionPreference = "Continue"
& $javaExe "-Xmx4G" "-jar" $otpJar "--build" "--save" $otpDirectory 2>&1 |
    Tee-Object -FilePath $logFile

exit $LASTEXITCODE
