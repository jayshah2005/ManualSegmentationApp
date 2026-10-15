"""FastAPI entrypoint.

Startup wires shared state (settings, model registry, session, sample index) onto
``app.state``. Models load lazily on first use and torch/sam2 are optional at
boot, so the setup screen works on a fresh machine.

Dev: Vite on :5173 proxies ``/api`` → uvicorn on :8000.
Prod: build ``frontend/dist`` and this process serves the SPA + API together.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.api import session as session_routes
from backend.api import setup as setup_routes
from backend.api import workspace as workspace_routes
from backend.engine import EngineUnavailable
from backend.installer import JobManager
from backend.models import ModelRegistry
from backend.pipeline.discover import SampleIndex
from backend.session import SessionManager
from backend.settings import SettingsStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = SettingsStore()
    app.state.models = ModelRegistry()
    app.state.session_mgr = SessionManager()
    app.state.sample_index = SampleIndex()
    app.state.jobs = JobManager()
    yield


app = FastAPI(title="Segmentation Tool", lifespan=lifespan)
# Vite (dev) origin only — not needed when the SPA is served from this same app.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(EngineUnavailable)
async def engine_unavailable(_: Request, exc: EngineUnavailable):
    return JSONResponse(status_code=503, content={"detail": exc.message, "code": exc.code})


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(workspace_routes.router)
app.include_router(setup_routes.router)
app.include_router(session_routes.router)

# After `frontend` is built, serve the SPA from the same process (production).
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="spa")
