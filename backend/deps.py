"""FastAPI ``Depends()`` hooks. Shared objects live on ``app.state`` (see ``app.lifespan``)."""
from __future__ import annotations

from fastapi import Request

from backend.models import ModelRegistry
from backend.pipeline.discover import SampleIndex
from backend.session import SessionManager
from backend.settings import SettingsStore


def get_models(request: Request) -> ModelRegistry:
    return request.app.state.models


def get_session_mgr(request: Request) -> SessionManager:
    return request.app.state.session_mgr


def get_settings_store(request: Request) -> SettingsStore:
    return request.app.state.settings


def get_sample_index(request: Request) -> SampleIndex:
    return request.app.state.sample_index
