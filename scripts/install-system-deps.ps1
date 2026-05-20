param(
  [switch]$SkipChrome,
  [switch]$SkipTesseract
)

$ErrorActionPreference = "Stop"

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Has-Command winget)) {
  Write-Error "winget is required for this helper. Install dependencies manually or install App Installer from Microsoft Store."
}

if (-not $SkipChrome) {
  Write-Host "Installing Google Chrome if missing..."
  winget install --id Google.Chrome --source winget --accept-package-agreements --accept-source-agreements
}

if (-not $SkipTesseract) {
  Write-Host "Installing Tesseract OCR if missing..."
  winget install --id UB-Mannheim.TesseractOCR --source winget --accept-package-agreements --accept-source-agreements
  Write-Host ""
  Write-Host "Tesseract must have chi_sim and eng language data available."
  Write-Host "If chi_sim is missing, install Simplified Chinese language data in the Tesseract installer or download chi_sim.traineddata into the tessdata directory."
}

Write-Host ""
Write-Host "Kimi CLI is not installed by this helper. If you use the kimi runtime, install the official Kimi CLI and make sure the kimi command is in PATH, or set KIMI_CLI_PATH."
Write-Host ""
Write-Host "Run pnpm doctor to verify the environment."
