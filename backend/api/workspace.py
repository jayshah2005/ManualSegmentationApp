"""Settings, folder browsing and the image list.

None of these routes take the session lock, so they stay responsive while SAM
is busy.
"""
from __future__ import annotations

import os
import string
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError

from backend import engine
from backend.deps import get_models, get_sample_index, get_settings_store
from backend.models import ModelRegistry
from backend.pipeline import progress as progress_mod
from backend.pipeline.discover import SampleIndex
from backend.pipeline.loaders import SUPPORTED_EXTS
from backend.settings import SettingsStore

router = APIRouter(tags=["workspace"])


@router.get("/api/settings")
def get_settings(store: SettingsStore = Depends(get_settings_store)):
    return store.get().model_dump()


@router.put("/api/settings")
def update_settings(
    patch: dict[str, Any] = Body(...),
    store: SettingsStore = Depends(get_settings_store),
    models: ModelRegistry = Depends(get_models),
    index: SampleIndex = Depends(get_sample_index),
):
    """Deep-merge a partial settings object (e.g. ``{"export": {"saveMask": false}}``)."""
    before = store.get()
    merged_in = patch.get("inputDir", before.inputDir)
    merged_out = patch.get("outputDir", before.outputDir)
    if merged_in and not Path(merged_in).expanduser().is_dir():
        raise HTTPException(status_code=400, detail=f"Input folder not found: {merged_in}")
    if merged_in and merged_out:
        a, b = Path(merged_in).expanduser().resolve(), Path(merged_out).expanduser().resolve()
        if a == b:
            raise HTTPException(status_code=400, detail="Output folder must differ from the input folder")
    for key in ("inputDir", "outputDir"):
        if isinstance(patch.get(key), str) and patch[key]:
            patch[key] = str(Path(patch[key]).expanduser().resolve())
    try:
        after = store.update(patch)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False, include_context=False)) from exc
    if (before.samModel, before.device) != (after.samModel, after.device):
        models.release()
    return after.model_dump()


def _count_supported(folder: Path) -> int:
    try:
        return sum(1 for e in os.scandir(folder) if e.is_file() and Path(e.name).suffix.lower() in SUPPORTED_EXTS)
    except OSError:
        return 0


def _roots() -> list[dict]:
    roots = [{"name": "Home", "path": str(Path.home())}]
    for sub in ("Desktop", "Documents", "Pictures", "Downloads"):
        p = Path.home() / sub
        if p.is_dir():
            roots.append({"name": sub, "path": str(p)})
    if os.name == "nt":
        roots += [{"name": f"{d}:", "path": f"{d}:\\"} for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
    else:
        roots.append({"name": "Computer", "path": "/"})
        for mount_dir in ("/media", "/mnt", "/Volumes"):
            m = Path(mount_dir)
            if m.is_dir():
                roots += [{"name": c.name, "path": str(c)} for c in sorted(m.iterdir()) if c.is_dir()]
    return roots


@router.get("/api/fs/list")
def fs_list(path: str = "", showHidden: bool = False):
    """Sub-folders of ``path`` (home when empty) for the folder-picker dialog."""
    folder = Path(path).expanduser() if path else Path.home()
    try:
        folder = folder.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not folder.is_dir():
        raise HTTPException(status_code=404, detail=f"Folder not found: {folder}")
    entries = []
    try:
        for e in sorted(os.scandir(folder), key=lambda e: e.name.lower()):
            if not e.is_dir(follow_symlinks=True):
                continue
            if e.name.startswith(".") and not showHidden:
                continue
            entries.append({"name": e.name, "path": str(Path(e.path))})
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"No permission to open {folder}") from exc
    parent = str(folder.parent) if folder.parent != folder else None
    return {
        "path": str(folder),
        "parent": parent,
        "folders": entries,
        "imageCount": _count_supported(folder),
        "writable": os.access(folder, os.W_OK),
        "roots": _roots(),
    }


@router.post("/api/fs/mkdir")
def fs_mkdir(body: dict[str, str] = Body(...)):
    """Create a new folder (used by 'New folder' in the output picker)."""
    parent, name = body.get("path", ""), body.get("name", "").strip()
    if not name or any(c in name for c in '/\\:*?"<>|') or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid folder name")
    target = Path(parent).expanduser() / name
    try:
        target.mkdir(parents=False, exist_ok=False)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail="That folder already exists") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"path": str(target)}


@router.get("/api/samples")
def list_samples(
    refresh: bool = False,
    store: SettingsStore = Depends(get_settings_store),
    index: SampleIndex = Depends(get_sample_index),
):
    """Every image/cube found under the input folder, with its progress status."""
    s = store.get()
    if not s.inputDir:
        return {"configured": False, "samples": [], "counts": {}}
    try:
        samples = index.scan(s.inputDir, s.recursive, s.outputDir, force=refresh)
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail=f"Input folder not found: {s.inputDir}") from exc
    try:
        progress = progress_mod.load_progress(s.outputDir) if s.outputDir else {}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    rows, counts = [], {"Pending": 0, "Incomplete": 0, "Completed": 0, "Skipped": 0}
    for smp in samples:
        status = progress_mod.sample_status(progress, smp.key)
        counts[status] = counts.get(status, 0) + 1
        rows.append(
            {"key": smp.key, "name": smp.name, "parent": smp.parent, "format": smp.format,
             "isFolder": smp.is_folder, "status": status}
        )
    first = next((r["key"] for r in rows if r["status"] in ("Pending", "Incomplete")), None)
    return {
        "configured": True,
        "inputDir": s.inputDir,
        "outputDir": s.outputDir,
        "samples": rows,
        "counts": counts,
        "firstPendingKey": first,
    }


@router.get("/api/system")
def system(store: SettingsStore = Depends(get_settings_store)):
    """GPU / PyTorch / SAM 2 status with actionable problems (never takes the session lock)."""
    s = store.get()
    return engine.system_status(s.samModel, s.device)
