#!/usr/bin/env bash
# Developer mode: API with auto-reload on :8000 + Vite dev server on :5173 (proxies /api).
# End users should run ./start.sh instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="${HOME}/.local/node/bin:${HOME}/.local/bin:${PATH}"   # Vite 8 needs Node 20+
export SAM2_BUILD_CUDA="${SAM2_BUILD_CUDA:-0}"
HOST="${SEGTOOL_HOST:-127.0.0.1}"
PORT="${SEGTOOL_PORT:-8000}"

cd "$ROOT"
# 'uv run' keeps PyTorch installed by the app; do not use a plain 'uv sync' here.
uv run uvicorn backend.app:app --host "$HOST" --port "$PORT" --reload --reload-dir backend &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

echo -n "Waiting for the API"
for _ in $(seq 1 120); do
  if ! kill -0 "$API_PID" 2>/dev/null; then echo; echo "API exited early." >&2; wait "$API_PID" || true; exit 1; fi
  if python3 -c "import sys,urllib.request as u; sys.exit(0 if u.urlopen('http://$HOST:$PORT/api/health',timeout=1).status==200 else 1)" 2>/dev/null; then
    echo " ready."
    cd "$ROOT/frontend"
    [[ -d node_modules ]] || npm install
    echo "UI: http://127.0.0.1:5173 (API on http://$HOST:$PORT)"
    exec npm run dev -- --host 127.0.0.1 --port 5173
  fi
  echo -n "."; sleep 0.25
done
echo "Timed out waiting for the API." >&2
exit 1
