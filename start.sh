#!/usr/bin/env sh
# LR Billing - first run installs everything, later runs just start the app.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }

[ -d node_modules ] || { echo "Installing packages (first run only)..."; npm install; }

if [ ! -d worker/.venv ]; then
  if command -v python3 >/dev/null 2>&1; then
    echo "Setting up the document reader (first run only)..."
    python3 -m venv worker/.venv && worker/.venv/bin/python -m pip install -q -r worker/requirements.txt
  else
    echo "Python 3.10+ not found: PDF and Excel document reading will be unavailable until it is installed."
  fi
fi

if [ ! -f web/dist/index.html ] || [ ! -f server/dist/index.js ]; then
  echo "Building the app (first run only)..."
  npm run build
fi

echo "Starting LR Billing on http://localhost:4000 (Ctrl+C to stop)"
npm start
