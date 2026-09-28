"""Vine catalog: folder lists + completion progress for the top-bar pickers.

``GET /api/vines`` is the first call on app boot. Each vine lists sample folders
and whether ``progress.json`` marks them Completed / Incomplete / Skipped / Pending.
``firstPending`` prefers Pending/Incomplete; only if none remain does it use Skipped.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import IMAGES
from backend.pipeline import load as load_mod
from backend.pipeline import save as save_mod

router = APIRouter(tags=["vines"])


@router.get("/api/vines")
def list_vines():
    try:
        progress = save_mod.load_progress()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    vines = []
    for name, path in IMAGES.items():
        base = Path(path)
        folders = load_mod.list_sample_folders(base) if base.exists() else []
        completed = sum(
            1
            for sf in folders
            if progress.get(f"{name}/{sf}", {}).get("status") == "Completed"
        )
        items = []
        for sf in folders:
            key = f"{name}/{sf}"
            items.append(
                {
                    "folder": sf,
                    "status": progress.get(key, {}).get("status", "Pending"),
                }
            )
        first_pending = save_mod.first_work_folder(folders, name, progress)
        vines.append(
            {
                "name": name,
                "folderCount": len(folders),
                "completedCount": completed,
                "folders": items,
                "firstPending": first_pending,
            }
        )
    return {"vines": vines}
