# flipscout one-time setup for Windows.
# Run in PowerShell from this folder:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (Get-Command py -ErrorAction SilentlyContinue) { $py = "py" }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = "python" }
else {
  Write-Host "Python not found. Install Python 3.10+ from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then re-run." -ForegroundColor Red
  exit 1
}
& $py -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 'Python 3.10+ required')"

Write-Host "==> Creating virtual environment (.venv)"
if (-not (Test-Path .venv)) { & $py -m venv .venv }
$vpy = ".\.venv\Scripts\python.exe"
$fs = ".\.venv\Scripts\flipscout.exe"

Write-Host "==> Installing flipscout and its dependencies"
& $vpy -m pip install --quiet --upgrade pip
& $vpy -m pip install --quiet -e ".[dev]"

Write-Host "==> Installing the Chromium browser flipscout drives"
& $vpy -m playwright install chromium

Write-Host "==> Running tests"
& $vpy -m pytest -q

if (-not (Test-Path config.local.yaml)) {
  Write-Host "==> First-time settings"
  & $fs setup
}

Write-Host "==> Building a sample report (made-up listings) so you can see the layout"
& $fs demo --open

Write-Host @"

Setup done. Next, in this folder:

  .\.venv\Scripts\Activate.ps1
  flipscout login                 # log into Facebook in flipscout's own browser window
  flipscout run --dry-run --open  # real scan, nothing sent; opens the report

Optional (do these before going live):
  flipscout email setup           # Gmail App Password for the daily email
  flipscout llm setup             # Anthropic API key (reads listings + replies)
"@
