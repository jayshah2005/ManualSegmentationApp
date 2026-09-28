"""FastAPI entrypoint.

Startup creates a shared ``ModelRegistry`` (SAM2 + EasyOCR) and a
``SessionManager`` (one active sample). Routers under ``backend.api`` own the
HTTP surface; this file only wires CORS, health, and optional static SPA hosting.

Dev: Vite on :5173 proxies ``/api`` → uvicorn on :8000.
Prod: build ``frontend/dist`` and this process serves the SPA + API together.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.api import session as session_routes
from backend.api import vines as vines_routes
from backend.models import ModelRegistry
from backend.session import SessionManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Models load lazily on first use; registry + session live on app.state.
    app.state.models = ModelRegistry()
    app.state.session_mgr = SessionManager()
    yield
    app.state.models = None
    app.state.session_mgr = None


app = FastAPI(title="HSI Leaf Curation", lifespan=lifespan)
# Vite (dev) origin only — not needed when the SPA is served from this same app.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(vines_routes.router)
app.include_router(session_routes.router)

# After `frontend` is built, serve the SPA from the same process (production).
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="spa")
