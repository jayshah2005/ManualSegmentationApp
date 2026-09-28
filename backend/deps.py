"""FastAPI ``Depends()`` hooks.

Routes declare ``models: ModelRegistry = Depends(get_models)`` instead of
importing globals. Both objects are created once in ``app.lifespan`` and stored
on ``request.app.state``.
"""
from __future__ import annotations

from fastapi import Request

from backend.models import ModelRegistry
from backend.session import SessionManager


def get_models(request: Request) -> ModelRegistry:
    return request.app.state.models


def get_session_mgr(request: Request) -> SessionManager:
    return request.app.state.session_mgr
