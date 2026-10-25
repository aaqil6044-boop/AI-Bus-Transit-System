param(
    [Parameter(Mandatory = $true)][string]$VmIp,
    [Parameter(Mandatory = $true)][string]$KeyPath,
    [string]$User = "azureuser"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$files = @(
    (Join-Path $root "data\bengaluru_transit.db"),
    (Join-Path $root "otp\graph.obj"),
    (Join-Path $root "otp\otp-shaded-2.8.1.jar")
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing runtime file: $file" }
}

ssh -i $KeyPath "$User@$VmIp" "mkdir -p ~/bengaluru-runtime/data ~/bengaluru-runtime/otp"
scp -i $KeyPath $files[0] "$User@${VmIp}:bengaluru-runtime/data/bengaluru_transit.db"
scp -i $KeyPath $files[1] "$User@${VmIp}:bengaluru-runtime/otp/graph.obj"
scp -i $KeyPath $files[2] "$User@${VmIp}:bengaluru-runtime/otp/otp-shaded-2.8.1.jar"
ssh -i $KeyPath "$User@$VmIp" "sudo install -d -o azureuser -g azureuser /opt/bengaluru-transit/data /opt/bengaluru-transit/otp && sudo install -o azureuser -g azureuser -m 0644 ~/bengaluru-runtime/data/bengaluru_transit.db /opt/bengaluru-transit/data/bengaluru_transit.db && sudo install -o azureuser -g azureuser -m 0644 ~/bengaluru-runtime/otp/graph.obj /opt/bengaluru-transit/otp/graph.obj && sudo install -o azureuser -g azureuser -m 0644 ~/bengaluru-runtime/otp/otp-shaded-2.8.1.jar /opt/bengaluru-transit/otp/otp-shaded-2.8.1.jar && rm -rf ~/bengaluru-runtime"

Write-Host "Runtime files uploaded. Run deploy/azure/bootstrap.sh on the VM."
