"""Setup screen routes: install PyTorch / SAM 2, download models, restart the app."""
from __future__ import annotations

import os
import threading
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend import engine, installer
from backend.deps import get_settings_store
from backend.settings import SamModel, SettingsStore

router = APIRouter(tags=["setup"])

RESTART_EXIT_CODE = 75  # the launcher script restarts the app on this code


class InstallRequest(BaseModel):
    action: Literal["install_torch", "install_sam2", "download_model", "setup_all"]
    torchTag: str | None = None
    model: SamModel | None = None


def _jobs(request: Request) -> installer.JobManager:
    return request.app.state.jobs


@router.post("/api/setup/install")
def start_install(
    body: InstallRequest, request: Request, store: SettingsStore = Depends(get_settings_store)
):
    settings = store.get()
    model = body.model or settings.samModel
    status = engine.system_status(model, settings.device)
    steps = installer.plan_steps(body.action, status, body.torchTag, model)
    if not steps:
        raise HTTPException(status_code=400, detail="Everything is already installed")
    try:
        return _jobs(request).start(body.action, steps).snapshot()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/setup/job")
def get_job(request: Request, since: int = 0):
    """Progress + new log lines of the latest setup job (``job: null`` if none yet)."""
    job = _jobs(request).current()
    return {"job": job.snapshot(since) if job else None}


@router.post("/api/setup/restart")
def restart_app():
    """Exit with a restart code so the launcher relaunches us (needed after a GPU build swap)."""
    threading.Timer(0.5, lambda: os._exit(RESTART_EXIT_CODE)).start()
    return {"restarting": True}
