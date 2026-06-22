#!/usr/bin/env bash
# Live Translation — one-command setup
# Installs dependencies and prepares your .env. Works on Linux, macOS, and
# Windows (Git Bash / WSL).
set -e

echo "==> Setting up Live Translation"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org and re-run."
  exit 1
fi
echo "==> Node $(node -v)"

# 2. Dependencies
npm install

# 3. Environment file
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example"
  echo "    >> Open .env and paste your SARVAM_API_KEY (get one at https://www.sarvam.ai)"
else
  echo "==> .env already exists — leaving it as is"
fi

echo ""
echo "==> Done. Add your key to .env, then start the server:"
echo "    npm start          (or: bash run.sh)"
echo "    open http://localhost:3000"
