# One-line setup for Windows.
# Usage (Admin PowerShell):
#   git clone <repo-url> simple-vpn; cd simple-vpn; .\quickstart.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  simple-vpn quickstart" -ForegroundColor Cyan
Write-Host "  ====================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = (node -v) -replace '^v', '' -split '\.'
    $nodeMajor = [int]$nodeVersion[0]
} catch {
    Write-Host "ERROR: Node.js not found. Install from: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

if ($nodeMajor -lt 20) {
    Write-Host "ERROR: Node.js >= 20 required (found v$($nodeVersion -join '.'))." -ForegroundColor Red
    exit 1
}
Write-Host "  Node.js $nodeMajor.x detected."

# Install deps
Write-Host "  Installing dependencies..."
npm install --silent

# Build
Write-Host "  Compiling TypeScript..."
npm run build --silent

# Check WireGuard
$wgPath = "C:\Program Files\WireGuard\wg.exe"
if (-not (Test-Path $wgPath)) {
    Write-Host ""
    Write-Host "  WireGuard for Windows not found." -ForegroundColor Yellow
    Write-Host "  Download and install from: https://www.wireguard.com/install/" -ForegroundColor Yellow
    Write-Host "  Then re-run: .\quickstart.ps1" -ForegroundColor Yellow
    exit 1
}
$env:PATH = "C:\Program Files\WireGuard;$env:PATH"
Write-Host "  WireGuard ready."

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  Relaunching as Administrator..." -ForegroundColor Yellow
    Start-Process node -ArgumentList "dist\src\index.js" -Verb RunAs
} else {
    Write-Host ""
    Write-Host "  Starting simple-vpn daemon..." -ForegroundColor Cyan
    Write-Host ""
    node dist\src\index.js
}
