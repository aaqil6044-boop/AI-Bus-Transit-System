$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$python312 = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$pythonExe = if (Test-Path -LiteralPath $python312) { $python312 } elseif ($pythonCommand) { $pythonCommand.Source } else { $null }
function Find-Java {
    # Prefer the JDK this project was built with, then JAVA_HOME, any Microsoft/Temurin JDK 21+, then PATH.
    $candidates = @('C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe')
    if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin\java.exe') }
    foreach ($root in @('C:\Program Files\Microsoft', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java')) {
        if (Test-Path -LiteralPath $root) {
            $candidates += Get-ChildItem -LiteralPath $root -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'bin\java.exe' }
        }
    }
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    $onPath = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}
$javaExe = Find-Java
$otpDir = Join-Path $projectRoot 'otp'
$otpProcess = $null

function Test-Router {
    try {
        # A full route listing is huge and can time out even when OTP is healthy.
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/otp/gtfs/v1' -Method Post -ContentType 'application/json' -Body '{"query":"{__typename}"}' -TimeoutSec 5
        return ($result.data.__typename -eq 'QueryType')
    } catch { return $false }
}

try {
    if (-not $pythonExe) { throw 'Python was not found. Install Python 3.12 or newer and make sure python.exe is on PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $otpDir 'graph.obj'))) {
        throw 'Routing graph is missing. Run build-otp-graph.cmd first.'
    }
    if (-not (Test-Router)) {
        if (-not $javaExe) { throw 'Java 21 was not found. Install a JDK 21 (for example Microsoft OpenJDK 21) or set JAVA_HOME, then run this again.' }
        Write-Host 'Loading the bus and walking network. Please wait...' -ForegroundColor Cyan
        $jar = Join-Path $otpDir 'otp-shaded-2.8.1.jar'
        $arguments = "-Xmx4G -jar `"$jar`" --load --port 8766 --bindAddress 127.0.0.1 `"$otpDir`""
        $otpProcess = Start-Process -FilePath $javaExe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $otpDir 'router.log') -RedirectStandardError (Join-Path $otpDir 'router-error.log')
        $deadline = (Get-Date).AddSeconds(180)
        while (-not (Test-Router)) {
            if ($otpProcess.HasExited) { throw "Route engine stopped. See otp\router.log and otp\router-error.log." }
            if ((Get-Date) -gt $deadline) { throw 'Route engine did not start within 3 minutes. See otp\router.log.' }
            Start-Sleep -Seconds 2
        }
    }
    Write-Host 'Ready. Open http://127.0.0.1:8765/ and keep this window open.' -ForegroundColor Green
    & $pythonExe (Join-Path $projectRoot 'app.py')
} finally {
    if ($otpProcess -and -not $otpProcess.HasExited) { Stop-Process -Id $otpProcess.Id }
}
