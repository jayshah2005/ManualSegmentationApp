#!/usr/bin/env bash
# Start the Vite frontend. No PATH setup required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND="$ROOT/frontend"
LOCAL_NODE="$HOME/.local/node/bin"

node_major() {
  local bin="$1"
  "$bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

pick_node() {
  local local_bin="$LOCAL_NODE/node"
  local sys_bin=""
  if command -v node >/dev/null 2>&1; then
    sys_bin="$(command -v node)"
  fi

  # Prefer user-local Node 20+ when present (Vite 8 needs Node 20+)
  if [[ -x "$local_bin" ]]; then
    local major
    major="$(node_major "$local_bin")"
    if (( major >= 20 )); then
      export PATH="$LOCAL_NODE:$PATH"
      return 0
    fi
  fi

  if [[ -n "$sys_bin" ]]; then
    local major
    major="$(node_major "$sys_bin")"
    if (( major >= 20 )); then
      return 0
    fi
    echo "System Node is v$("$sys_bin" -v) (need 20+)." >&2
  fi

  echo "Node.js 20+ not found. Install Node, or place it at ~/.local/node/bin/node" >&2
  exit 1
}

pick_node

cd "$FRONTEND"
if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies…"
  npm install
fi

echo "Using Node $(node -v)"
echo "Starting UI at http://127.0.0.1:5173 (proxies /api → :8000)"
exec npm run dev -- --host 127.0.0.1 --port 5173
