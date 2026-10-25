# Execution OS — one-command install for Windows.
#
#   powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://raw.githubusercontent.com/pragyesh85-SPT/execution-os/main/scripts/install.ps1 | iex"
#
# Pinned to a release instead of main:
#   ... "irm https://github.com/pragyesh85-SPT/execution-os/releases/download/v2.0.0/install.ps1 | iex"
#
# What it does (every step is printed):
#   1. finds the latest release on GitHub and downloads ExecutionOS-<version>-setup.exe and SHA256SUMS.txt
#   2. verifies the SHA-256 of the installer and stops if it does not match
#   3. runs the installer silently and finds the installed app
#   4. offers to install Tailscale (for syncing outside home) with winget — you answer Y or n
#   5. starts Execution OS once with --first-run (turns on "Start with Windows" and opens the welcome wizard)
# It never disables security features and asks for no admin rights beyond what the installer itself needs.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'pragyesh85-SPT/execution-os'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Install stopped: $text" -ForegroundColor Red; exit 1 }

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

Step "Looking up the latest Execution OS release"
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'execution-os-installer' }
} catch {
  Fail "could not reach GitHub ($($_.Exception.Message)). Check the internet connection and try again."
}
$version = $release.tag_name
$setup = $release.assets | Where-Object { $_.name -like 'ExecutionOS-*-setup.exe' } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if (-not $setup) { Fail "release $version has no setup.exe." }
if (-not $sums) { Fail "release $version has no SHA256SUMS.txt, so the download cannot be verified." }
Write-Host "    $version · $($setup.name) ($([math]::Round($setup.size / 1MB)) MB)"

$dir = Join-Path $env:TEMP "execution-os-install"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir $setup.name
$sumFile = Join-Path $dir 'SHA256SUMS.txt'

Step "Downloading the installer"
Invoke-WebRequest -Uri $setup.browser_download_url -OutFile $exe -UseBasicParsing
Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumFile -UseBasicParsing

Step "Verifying the SHA-256 checksum"
$expected = $null
foreach ($line in Get-Content $sumFile) {
  $parts = $line -split '\s+', 2
  if ($parts.Count -eq 2 -and $parts[1].Trim().TrimStart('*') -eq $setup.name) { $expected = $parts[0].Trim().ToLower() }
}
if (-not $expected) { Fail "SHA256SUMS.txt has no line for $($setup.name)." }
$actual = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower()
if ($actual -ne $expected) {
  Remove-Item $exe -Force
  Fail "checksum mismatch (expected $expected, got $actual). The download was deleted. Do not run it."
}
Write-Host "    OK $actual"

Step "Installing Execution OS (silent)"
$p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { Fail "the installer exited with code $($p.ExitCode)." }

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Execution OS\Execution OS.exe'),
  (Join-Path $env:ProgramFiles 'Execution OS\Execution OS.exe')
)
$app = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $app) { Fail "installed, but Execution OS.exe was not found in the usual folders. Start it from the Start menu." }
Write-Host "    Installed: $app"

$tailscale = Test-Path 'C:\Program Files\Tailscale\tailscale.exe'
if (-not $tailscale) {
  Step "Tailscale (optional) keeps your phone syncing outside home Wi-Fi and lets Claude reach the AI connector."
  $answer = Read-Host "    Install Tailscale now? (Y/n)"
  if ($answer -eq '' -or $answer -match '^[Yy]') {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
      Write-Host "    Open Tailscale from the Start menu and sign in once."
    } else {
      Write-Host "    winget is not available. Download Tailscale from https://tailscale.com/download/windows"
    }
  } else {
    Write-Host "    Skipped. You can install it later from https://tailscale.com/download/windows"
  }
}

Step "Starting Execution OS"
Start-Process -FilePath $app -ArgumentList '--first-run'
Write-Host ""
Write-Host "Execution OS $version is running. The welcome wizard ends with a QR code for your phone." -ForegroundColor Green
Write-Host "Data lives in $env:APPDATA\execution-os and survives updates and reinstalls."
