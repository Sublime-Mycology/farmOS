# Agent Colony + Clip Factory: one-step install for Windows.
#
# Paste this into PowerShell (the normal one, not "as administrator"):
#
#   irm https://raw.githubusercontent.com/Sublime-Mycology/farmOS/clip-factory/setup-windows.ps1 | iex
#
# Or double-click "Install Agent Colony.cmd", which runs the same thing.
# Set COLONY_SETUP_QUIET=1 to skip the questions (for running it from an agent).
# Everything it prints is also saved to %USERPROFILE%\ClipFactory\setup-log.txt.
#
# It installs Git, Node.js, Python and Claude Code if they're missing, downloads Agent Colony and
# Clip Factory into %USERPROFILE%\code, adds Clip Factory to the colony (allowed to run its clipper),
# helps you make your first channel, puts an "Agent Colony" shortcut on your desktop, and starts it.
# Safe to run again at any time: it updates what's there and skips what's done.

& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoUrl   = 'https://github.com/Sublime-Mycology/farmOS.git'
$ColonyBr  = 'claude/multi-agent-task-viz-ul1iul'
$ClipBr    = 'clip-factory'
$Code      = Join-Path $HOME 'code'
$ColonySrc = Join-Path $Code 'agent-colony'
$Colony    = Join-Path $ColonySrc 'tools\agent-colony'
$Clip      = Join-Path $Code 'clip-factory'
$Media     = Join-Path $HOME 'ClipFactory'
$VenvPy    = Join-Path $Media '.venv\Scripts\python.exe'
$Quiet     = [bool]$env:COLONY_SETUP_QUIET

# GitHub needs TLS 1.2, which older Windows PowerShell doesn't turn on by itself.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Media | Out-Null
try { Start-Transcript -Path (Join-Path $Media 'setup-log.txt') -Force | Out-Null } catch { }
try {

function Step([string]$Msg) { Write-Host ''; Write-Host "==> $Msg" -ForegroundColor Green }
function Note([string]$Msg) { Write-Host "    $Msg" -ForegroundColor DarkGray }
function Have([string]$Cmd) { [bool](Get-Command $Cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
# Run a program and stop the install if it fails.
function Run([string]$Exe) {
  & $Exe @args
  if ($LASTEXITCODE -ne 0) { throw "This step failed: $Exe $($args -join ' ') (exit code $LASTEXITCODE)" }
}
function Ensure([string]$Cmd, [string]$Id, [string]$Name) {
  if (Have $Cmd) { Note "${Name}: already installed"; return }
  Step "Installing $Name"
  winget install --exact --id $Id --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Have $Cmd)) {
    throw "$Name was installed but Windows hasn't picked it up yet. Close PowerShell, open a new one, and paste the same line again."
  }
}

# 1. Tools --------------------------------------------------------------------------------------
Step 'Checking what is installed'
if (-not (Have 'winget')) {
  throw 'winget is missing. Install "App Installer" from the Microsoft Store, then paste the same line again.'
}
Ensure 'git'  'Git.Git'            'Git'
Ensure 'node' 'OpenJS.NodeJS.LTS'  'Node.js'
Ensure 'py'   'Python.Python.3.12' 'Python'

$nodeMajor = [int](((& node -v) -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
  Step 'Updating Node.js (need version 20 or newer)'
  winget upgrade --exact --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
& py -3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'
if ($LASTEXITCODE -ne 0) {
  Step 'Installing a newer Python (need 3.9 or newer)'
  winget install --exact --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
}

if (Have 'claude') { Note 'Claude Code: already installed' } else {
  Step 'Installing Claude Code'
  Run 'npm.cmd' install -g '@anthropic-ai/claude-code' --no-audit --no-fund --loglevel=error
  Refresh-Path
}

# 2. Code ---------------------------------------------------------------------------------------
Step 'Downloading Agent Colony and Clip Factory'
New-Item -ItemType Directory -Force -Path $Code | Out-Null
function Sync([string]$Dir, [string]$Branch, [string[]]$Extra) {
  if (Test-Path (Join-Path $Dir '.git')) {
    Note "Updating $Dir"
    Run 'git' -C $Dir pull --ff-only --quiet
  } else {
    Note "Downloading to $Dir"
    Run 'git' clone --quiet --single-branch --branch $Branch @Extra $RepoUrl $Dir
  }
}
Sync $ColonySrc $ColonyBr @('--depth', '1')
Sync $Clip $ClipBr @()

# 3. Install ------------------------------------------------------------------------------------
Step 'Installing the colony'
Push-Location $Colony
try { Run 'npm.cmd' install --no-audit --no-fund --loglevel=error } finally { Pop-Location }

Step 'Installing the clipper (yt-dlp and a video editor), about a minute'
New-Item -ItemType Directory -Force -Path (Join-Path $Media 'channels') | Out-Null
if (-not (Test-Path $VenvPy)) { Run 'py' -3 -m venv (Join-Path $Media '.venv') }
Run $VenvPy -m pip install --quiet --disable-pip-version-check --upgrade -r (Join-Path $Clip 'requirements.txt')
Run $VenvPy (Join-Path $Clip 'clipper.py') doctor

Step 'Adding Clip Factory to the colony'
Run 'node' (Join-Path $Colony 'scripts\add-repo.mjs') $Clip --allow

# 4. First channel ------------------------------------------------------------------------------
$channels = @(Get-ChildItem -Path (Join-Path $Media 'channels') -Filter '*.json' -ErrorAction SilentlyContinue)
if ($channels.Count -eq 0 -and $Quiet) {
  Note 'No channels yet. Make one with: clipper new-channel (or ask an agent on the clip-factory plot).'
} elseif ($channels.Count -eq 0) {
  Step 'Your first channel: a few quick questions (press Enter to accept a [default])'
  & $VenvPy (Join-Path $Clip 'clipper.py') new-channel
} else {
  Note "Channels already set up: $(($channels | ForEach-Object { $_.BaseName }) -join ', ')"
}

# 5. Claude sign-in -----------------------------------------------------------------------------
$claudeJson = Join-Path $HOME '.claude.json'
$signedIn = [bool]$env:ANTHROPIC_API_KEY
if (-not $signedIn -and (Test-Path $claudeJson)) {
  $signedIn = [bool](Select-String -Path $claudeJson -Pattern '"oauthAccount"' -Quiet)
}
if (-not $signedIn -and $Quiet) {
  Note 'Claude Code is not signed in yet: run claude in a terminal once and sign in.'
} elseif (-not $signedIn) {
  Step 'Sign in to Claude Code (agents run as you)'
  Note 'Claude Code opens here. Follow its sign-in steps, then type /exit and press Enter to finish setup.'
  & claude.cmd
}

# 6. Shortcut and start -------------------------------------------------------------------------
Step 'Putting an "Agent Colony" shortcut on your desktop'
$desktop = [Environment]::GetFolderPath('Desktop')
$launcher = Join-Path $desktop 'Agent Colony.cmd'
$lines = @(
  '@echo off',
  'title Agent Colony',
  "cd /d `"$Colony`"",
  'echo Agent Colony is running. Keep this window open; close it to stop.',
  'start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:5274/"',
  'node server.mjs',
  'pause'
)
Set-Content -Path $launcher -Value $lines -Encoding ASCII

Step 'Starting Agent Colony'
Start-Process -FilePath $launcher

Write-Host ''
Write-Host 'All set!' -ForegroundColor Green
Write-Host '  * Your browser opens the colony in a few seconds (http://127.0.0.1:5274).'
Write-Host '  * Next time, double-click "Agent Colony" on your desktop.'
Write-Host '  * To make clips: click clip-factory in the right panel, then New conversation, and type e.g.'
Write-Host '      Make shorts and one long clip from https://youtu.be/VIDEO_ID for YOUR-CHANNEL'
Write-Host '  * To add a creator who said yes: tell any agent there, e.g.'
Write-Host '      Add @CreatorHandle to YOUR-CHANNEL, they allowed clipping via their clip program'
Write-Host "  * Finished clips to review: $Media\review"
} finally {
  try { Stop-Transcript | Out-Null } catch { }
}
}
