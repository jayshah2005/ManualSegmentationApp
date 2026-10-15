#!/usr/bin/env bash
# Segmentation Tool launcher for Linux and macOS.
# First run installs the app's libraries (1–2 minutes); later runs start in seconds.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing 'uv' (the tool that sets up Python for this app) …"
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh
  else
    echo "Please install curl or wget, or install uv from https://docs.astral.sh/uv/" >&2
    exit 1
  fi
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

echo "Preparing Segmentation Tool (this takes a minute the first time) …"
# --inexact keeps PyTorch/SAM 2 that the app installed for your GPU; a plain 'uv sync' would remove them.
uv sync --no-dev --inexact --frozen
exec uv run --no-dev --frozen python scripts/run_app.py "$@"
