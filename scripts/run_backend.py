#!/usr/bin/env python3
"""Start the HSI curation API with uv (project-local .venv).

Requires `uv` on PATH. Does not use pip or ../my_env.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    uv = shutil.which("uv")
    if not uv:
        print(
            "uv not found. Install it from https://docs.astral.sh/uv/\n"
            "  curl -LsSf https://astral.sh/uv/install.sh | sh",
            file=sys.stderr,
        )
        sys.exit(1)

    os.chdir(ROOT)
    # Skip SAM2 CUDA extension build unless the user opts in (needs matching nvcc).
    os.environ.setdefault("SAM2_BUILD_CUDA", "0")

    host = os.environ.get("HSI_HOST", "127.0.0.1")
    port = os.environ.get("HSI_PORT", "8000")
    print(f"Starting API at http://{host}:{port} (via uv run)")
    os.execv(
        uv,
        [
            uv,
            "run",
            "uvicorn",
            "backend.app:app",
            "--host",
            host,
            "--port",
            port,
        ],
    )


if __name__ == "__main__":
    main()
