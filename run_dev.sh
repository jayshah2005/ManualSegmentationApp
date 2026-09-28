#!/usr/bin/env bash
# Start API + Vite UI for local curation (uv + npm).
# Waits until the API accepts connections so the first /api/vines call does not race.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="${HOME}/.local/node/bin:${PATH}"
export SAM2_BUILD_CUDA="${SAM2_BUILD_CUDA:-0}"

API_HOST="${HSI_HOST:-127.0.0.1}"
API_PORT="${HSI_PORT:-8000}"
API_URL="http://${API_HOST}:${API_PORT}/api/vines"

api_ready() {
  python3 - "$API_URL" <<'PY'
import sys, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=1) as r:
        sys.exit(0 if 200 <= r.status < 500 else 1)
except Exception:
    sys.exit(1)
PY
}

cd "$ROOT"
"$ROOT/scripts/run_backend.py" &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

echo -n "Waiting for API"
for _ in $(seq 1 120); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo
    echo "API process exited before becoming ready." >&2
    wait "$API_PID" || true
    exit 1
  fi
  if api_ready; then
    echo " ready."
    exec "$ROOT/scripts/run_frontend.sh"
  fi
  echo -n "."
  sleep 0.25
done

echo
echo "Timed out waiting for API at ${API_URL}" >&2
exit 1
