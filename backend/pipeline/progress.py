"""Per-output-folder progress: which samples are Completed / Incomplete / Skipped.

Stored as ``segmentation_progress.json`` inside the output folder so a session
can be resumed (or shared) simply by pointing the app at the same folders.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from backend.pipeline.discover import Sample

PROGRESS_NAME = "segmentation_progress.json"
_lock = threading.Lock()


def progress_path(output_dir: Path | str) -> Path:
    return Path(output_dir) / PROGRESS_NAME


def load_progress(output_dir: Path | str) -> dict:
    path = progress_path(output_dir)
    with _lock:
        try:
            return json.loads(path.read_text("utf-8")) if path.exists() else {}
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Progress file is corrupt ({path}): {exc}") from exc
        except OSError as exc:
            raise RuntimeError(f"Cannot read progress file {path}: {exc}") from exc


def save_progress(output_dir: Path | str, progress: dict) -> None:
    path = progress_path(output_dir)
    with _lock:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(progress, indent=2), "utf-8")
            tmp.replace(path)
        except OSError as exc:
            raise RuntimeError(f"Cannot write progress file {path}: {exc}") from exc


def sample_status(progress: dict, key: str) -> str:
    return str(progress.get(key, {}).get("status") or "Pending")


def next_sample_key(samples: list[Sample], current: str, progress: dict) -> str | None:
    """Next sample after ``current`` (wrapping): active ones first, then Skipped.

    Completed samples are never chosen.
    """
    if not samples:
        return None
    keys = [s.key for s in samples]
    start = keys.index(current) if current in keys else -1
    n = len(keys)

    def walk(accept) -> str | None:
        for i in range(1, n + 1):
            cand = keys[(start + i) % n]
            if cand != current and accept(sample_status(progress, cand)):
                return cand
        return None

    return walk(lambda st: st not in ("Completed", "Skipped")) or walk(lambda st: st == "Skipped")
