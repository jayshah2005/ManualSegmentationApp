#!/usr/bin/env python3
"""Start Segmentation Tool and keep it running.

This is what ``start.sh`` / ``start.bat`` run. It

1. picks a free port (8000, or the next free one),
2. starts the web server as a child process,
3. opens the browser once the server answers,
4. restarts the server when the app asks for it (exit code 75, used after the
   setup screen swaps in a different PyTorch build),
5. shuts the child down cleanly on Ctrl+C.

Environment: ``SEGTOOL_PORT`` (preferred port), ``SEGTOOL_NO_BROWSER=1`` (do not
open a browser), ``SEGTOOL_HOST`` (default 127.0.0.1; keep it local).
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESTART_EXIT_CODE = 75  # keep in sync with backend/api/setup.py


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def pick_port(host: str, preferred: int, tries: int = 20) -> int:
    for port in range(preferred, preferred + tries):
        if port_is_free(host, port):
            return port
    raise SystemExit(f"No free port found between {preferred} and {preferred + tries - 1}.")


def wait_until_healthy(url: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=1.5) as r:
                if r.status == 200:
                    return True
        except OSError:
            time.sleep(0.4)
    return False


def open_browser_when_ready(url: str) -> None:
    if wait_until_healthy(url):
        print(f"\nSegmentation Tool is ready: {url}\n(Close this window or press Ctrl+C to stop it.)\n", flush=True)
        if not os.environ.get("SEGTOOL_NO_BROWSER"):
            webbrowser.open(url)
    else:
        print("The app did not start in time. Scroll up for error messages.", file=sys.stderr)


def _raise_interrupt(*_: object) -> None:
    raise KeyboardInterrupt  # treat SIGTERM like Ctrl+C so the child server is stopped too


def main() -> int:
    signal.signal(signal.SIGTERM, _raise_interrupt)
    host = os.environ.get("SEGTOOL_HOST", "127.0.0.1")
    port = pick_port(host, int(os.environ.get("SEGTOOL_PORT", "8000")))
    url = f"http://{host}:{port}"
    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        print(
            "Note: the built web interface (frontend/dist) is missing, so only the API will run.\n"
            "Build it with: cd frontend && npm install && npm run build",
            file=sys.stderr,
        )
    cmd = [sys.executable, "-m", "uvicorn", "backend.app:app", "--host", host, "--port", str(port), "--log-level", "warning"]
    env = {**os.environ, "SAM2_BUILD_CUDA": os.environ.get("SAM2_BUILD_CUDA", "0")}

    print(f"Starting Segmentation Tool on {url} …", flush=True)
    threading.Thread(target=open_browser_when_ready, args=(url,), daemon=True).start()

    while True:
        child = subprocess.Popen(cmd, cwd=ROOT, env=env)
        try:
            code = child.wait()
        except KeyboardInterrupt:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
            return 0
        if code != RESTART_EXIT_CODE:
            return code
        print("Restarting to apply changes …", flush=True)
        for _ in range(50):  # wait for the old socket to be released
            if port_is_free(host, port):
                break
            time.sleep(0.2)


if __name__ == "__main__":
    sys.exit(main())
