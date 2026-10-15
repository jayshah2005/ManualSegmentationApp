"""User settings persisted as JSON in the platform config directory.

Replaces the old import-time ``config.py`` constants: every consumer reads the
current values through ``SettingsStore.get()`` so changes made in the Settings
modal apply immediately (no restart, no environment variables).

Set ``SEGTOOL_HOME`` to relocate all app data (settings + downloaded models);
tests use this to stay out of the real user directory.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Literal

from platformdirs import user_config_dir, user_data_dir
from pydantic import BaseModel, Field

APP_NAME = "segmentation-tool"

SamModel = Literal["tiny", "small", "base_plus", "large"]
DeviceChoice = Literal["auto", "cuda", "mps", "cpu"]
ExportFormat = Literal["same_as_input", "png", "tiff", "npy", "envi"]
MetadataFormat = Literal["none", "csv", "coco"]


def config_dir() -> Path:
    home = os.environ.get("SEGTOOL_HOME")
    return Path(home) / "config" if home else Path(user_config_dir(APP_NAME))


def data_dir() -> Path:
    home = os.environ.get("SEGTOOL_HOME")
    return Path(home) / "data" if home else Path(user_data_dir(APP_NAME))


def models_dir() -> Path:
    return data_dir() / "models"


class OrientationSettings(BaseModel):
    """Applied to every image so the canvas matches how users expect it to look."""

    rotate: Literal[0, 90, 180, 270] = 0  # clockwise degrees
    flipH: bool = False
    flipV: bool = False
    # Specim IQ stores frames sideways; turn those upright without any setup.
    autoUpright: bool = True


class DisplaySettings(BaseModel):
    """How a cube/16-bit image is turned into the 8-bit picture SAM and the canvas see."""

    bandMode: Literal["auto", "manual"] = "auto"
    bands: list[int] = Field(default_factory=lambda: [0, 1, 2])  # R, G, B (manual)
    stretchLow: float = Field(2.0, ge=0.0, le=49.0)
    stretchHigh: float = Field(98.0, ge=51.0, le=100.0)


class ExportSettings(BaseModel):
    format: ExportFormat = "same_as_input"
    cropToBBox: bool = True
    saveMask: bool = True
    # Viewable RGB cut-out next to ENVI/TIFF/NPY cubes (which no normal viewer can open).
    savePreview: bool = True
    metadata: MetadataFormat = "csv"


class Settings(BaseModel):
    inputDir: str = ""
    outputDir: str = ""
    recursive: bool = True
    samModel: SamModel = "base_plus"
    device: DeviceChoice = "auto"
    display: DisplaySettings = Field(default_factory=DisplaySettings)
    orientation: OrientationSettings = Field(default_factory=OrientationSettings)
    export: ExportSettings = Field(default_factory=ExportSettings)


def _merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


class SettingsStore:
    """Thread-safe load/patch/save of ``Settings``."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (config_dir() / "settings.json")
        self._lock = threading.Lock()
        self._settings = self._read()

    @property
    def path(self) -> Path:
        return self._path

    def _read(self) -> Settings:
        try:
            return Settings.model_validate(json.loads(self._path.read_text("utf-8")))
        except FileNotFoundError:
            return Settings()
        except (OSError, ValueError):
            # Corrupt/hand-edited file: fall back to defaults rather than refusing to boot.
            return Settings()

    def get(self) -> Settings:
        with self._lock:
            return self._settings.model_copy(deep=True)

    def update(self, patch: dict[str, Any]) -> Settings:
        """Deep-merge ``patch`` into the current settings, validate, persist."""
        with self._lock:
            merged = _merge(self._settings.model_dump(), patch)
            new = Settings.model_validate(merged)
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(new.model_dump(), indent=2), "utf-8")
            tmp.replace(self._path)
            self._settings = new
            return new.model_copy(deep=True)
