"""Progress JSON and per-leaf ENVI/PNG export under ``OUTPUT_BASE_DIR``.

Export layout::

    Data/{vineType}/{mainLabel}/{sublabel}/{sublabel}.{png,hdr,img}

``progress.json`` keys are ``{vineType}/{folder}`` with status
Completed / Incomplete / Skipped / Pending.

Queue order for boot and after Complete/Skip:
1. Pending or Incomplete (never Completed, never Skipped)
2. Skipped (only when nothing in (1) remains)
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import spectral
from spectral.io import envi

from backend.config import OUTPUT_BASE_DIR, PROGRESS_FILE, RGB_BANDS

_progress_lock = threading.Lock()


def load_progress() -> dict:
    with _progress_lock:
        try:
            if PROGRESS_FILE.exists():
                with open(PROGRESS_FILE, "r") as f:
                    return json.load(f)
            return {}
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Corrupt progress file {PROGRESS_FILE}: {exc}") from exc
        except OSError as exc:
            raise RuntimeError(f"Failed to read progress file {PROGRESS_FILE}: {exc}") from exc


def save_progress(progress: dict) -> None:
    with _progress_lock:
        try:
            OUTPUT_BASE_DIR.mkdir(parents=True, exist_ok=True)
            with open(PROGRESS_FILE, "w") as f:
                json.dump(progress, f, indent=4)
        except OSError as exc:
            raise RuntimeError(f"Failed to write progress file {PROGRESS_FILE}: {exc}") from exc


def sample_status(progress_data: dict, vine_type: str, folder: str) -> str:
    raw = progress_data.get(f"{vine_type}/{folder}", {}).get("status", "Pending")
    return str(raw or "Pending")


def _is_active(status: str) -> bool:
    """Pending / Incomplete / unknown — not Completed and not Skipped."""
    return status not in ("Completed", "Skipped")


def first_work_folder(
    subfolders: list[str], vine_type: str, progress_data: dict
) -> str | None:
    """Boot / vine-switch target: first active pending, else first Skipped."""
    if not subfolders:
        return None
    for sf in subfolders:
        if _is_active(sample_status(progress_data, vine_type, sf)):
            return sf
    for sf in subfolders:
        if sample_status(progress_data, vine_type, sf) == "Skipped":
            return sf
    return None


def next_pending_folder(
    subfolders: list[str], vine_type: str, current: str, progress_data: dict
) -> str | None:
    """Next sample after ``current``: prefer active pending, else Skipped.

    Walks forward from ``current`` (wrapping). Completed samples are never chosen.
    """
    if not subfolders:
        return None
    try:
        start = subfolders.index(current)
    except ValueError:
        start = -1

    n = len(subfolders)

    def walk(predicate) -> str | None:
        for i in range(1, n + 1):
            cand = subfolders[(start + i) % n]
            if predicate(sample_status(progress_data, vine_type, cand)):
                return cand
        return None

    nxt = walk(_is_active)
    if nxt is not None:
        return nxt
    return walk(lambda st: st == "Skipped")


def leaf_export_dir(vine_type: str, main_label: str, sublabel: str) -> Path:
    """``Data/{vine}/{main}/{sublabel}/`` — same path ``save_leaf`` writes into."""
    return OUTPUT_BASE_DIR / vine_type / main_label / sublabel


def export_exists(vine_type: str, main_label: str, sublabel: str) -> bool:
    """True if a previous save already wrote files for this leaf label."""
    out_dir = leaf_export_dir(vine_type, main_label, sublabel)
    if not out_dir.is_dir():
        return False
    try:
        return any(out_dir.iterdir())
    except OSError:
        return False


def save_leaf(hsi, vine_type: str, main_label: str, sublabel: str) -> Path:
    """Write ``Data/{vine}/{main}/{sublabel}/{sublabel}.{png,hdr,img}``."""
    out_dir = leaf_export_dir(vine_type, main_label, sublabel)
    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / f"{sublabel}.png"
    hdr_path = out_dir / f"{sublabel}.hdr"
    spectral.save_rgb(str(png_path), hsi, RGB_BANDS)
    envi.save_image(
        str(hdr_path),
        np.asarray(hsi),
        dtype=np.float32,
        force=True,
        ext=".img",
        interleave="bil",
    )
    return out_dir
