# Starts a Linkotter control server on this PC for a local-network test, opens the firewall port,
# and installs the Linkotter app on this PC.
#   powershell -ExecutionPolicy Bypass -File deploy\local-test\setup.ps1
# Needs Docker Desktop. Run from an administrator PowerShell so the firewall rule and app install work.
param([string]$LanIp = "", [int]$Port = 8080, [switch]$SkipApp)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not $LanIp) {
  # The address on the interface that holds the default route (Wi-Fi or Ethernet).
  $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
  if ($route) { $LanIp = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Select-Object -First 1).IPAddress }
}
if (-not $LanIp) { Fail "Could not find this PC's local IP address. Run again with -LanIp 192.168.x.x" }
docker info *> $null; if ($LASTEXITCODE) { Fail "Docker is not running. Start Docker Desktop and run this again." }

New-Item -ItemType Directory -Force config | Out-Null
(Get-Content config.yaml.tmpl -Raw).Replace("@LAN_IP@", $LanIp).Replace("@PORT@", "$Port") | Set-Content -NoNewline -Encoding utf8 config\config.yaml
(Get-Content derp.yaml.tmpl -Raw).Replace("@LAN_IP@", $LanIp) | Set-Content -NoNewline -Encoding utf8 config\derp.yaml
Copy-Item ..\templates\policy.hujson config\policy.hujson -Force

$env:PORT = "$Port"
docker compose up -d; if ($LASTEXITCODE) { Fail "docker compose failed" }
$url = "http://${LanIp}:$Port"
$up = $false
foreach ($i in 1..60) { try { Invoke-RestMethod "$url/health" -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep 1 } }
if (-not $up) { Fail "Server did not come up. See: docker logs linkotter-local" }

# Let phones and laptops on the network reach the server.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  if (-not (Get-NetFirewallRule -DisplayName "Linkotter local test server" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Linkotter local test server" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
  }
} else { Write-Host "Not running as administrator: allow TCP port $Port in Windows Firewall yourself if your phone cannot connect." -ForegroundColor Yellow }

function hs { docker exec linkotter-local headscale @args }
$users = hs users list -o json | ConvertFrom-Json
if (-not ($users | Where-Object name -eq "me")) { hs users create me | Out-Null; $users = hs users list -o json | ConvertFrom-Json }
$uid = ($users | Where-Object name -eq "me").id
$key = (hs preauthkeys create --user $uid --reusable --expiration 168h -o json | ConvertFrom-Json).key

# Install the app on this PC from the latest Windows build, if the GitHub CLI is available.
$installed = Test-Path "$env:ProgramFiles\Linkotter\Linkotter.exe"
if (-not $SkipApp -and -not $installed) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $dl = Join-Path $env:TEMP "linkotter-app"; Remove-Item $dl -Recurse -Force -ErrorAction SilentlyContinue
    $repo = "arshad-dracula/Linkotter"
    $branch = (git -C $PSScriptRoot rev-parse --abbrev-ref HEAD 2>$null)
    $run = gh run list -R $repo -w "Windows app" -b $branch -s success -L 1 --json databaseId -q ".[0].databaseId"
    if ($run) {
      gh run download $run -R $repo -n linkotter-windows -D $dl
      Write-Host "Installing Linkotter (approve the Windows prompt)..."
      Start-Process "$dl\LinkotterSetup.exe" -Wait
      $installed = Test-Path "$env:ProgramFiles\Linkotter\Linkotter.exe"
    } else { Write-Host "No finished Windows build found on branch $branch." -ForegroundColor Yellow }
  } else {
    Write-Host "To install the app: download LinkotterSetup.exe from the latest green 'Windows app' run under the repository's Actions tab." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Linkotter local test server is running." -ForegroundColor Green
Write-Host ""
Write-Host "  Server address:  $url"
Write-Host "  Access key:      $key   (works on all your devices for 7 days)"
Write-Host ""
Write-Host "On each device, open Linkotter, enter the server address, choose 'I have an access key' and paste the key."
Write-Host "For this test, devices must be on the same network as this PC."
if ($installed) { Write-Host "The Linkotter app is installed on this PC; it is in the Start menu and the tray." }
Write-Host "Stop the server with:  docker compose -f `"$PSScriptRoot\docker-compose.yml`" down"
