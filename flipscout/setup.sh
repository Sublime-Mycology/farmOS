#!/usr/bin/env bash
# flipscout one-time setup for macOS / Linux.  Run:  bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3 not found. Install it from https://www.python.org/downloads/ (3.10 or newer), then re-run." >&2
  exit 1
fi
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Python 3.10+ required (you have %s)" % sys.version.split()[0])'

echo "==> Creating virtual environment (.venv)"
[ -d .venv ] || "$PY" -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate

echo "==> Installing flipscout and its dependencies"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e ".[dev]"

echo "==> Installing the Chromium browser flipscout drives"
python -m playwright install chromium

echo "==> Running tests"
python -m pytest -q

if [ ! -f config.local.yaml ]; then
  echo "==> First-time settings"
  flipscout setup
fi

echo "==> Building a sample report (made-up listings) so you can see the layout"
flipscout demo --open || true

cat <<'EOF'

Setup done. Next, in this folder:

  source .venv/bin/activate
  flipscout login                 # log into Facebook in flipscout's own browser window
  flipscout run --dry-run --open  # real scan, nothing sent; opens the report

Optional (do these before going live):
  flipscout email setup           # Gmail App Password for the daily email
  flipscout llm setup             # Anthropic API key (reads listings + replies)
EOF
