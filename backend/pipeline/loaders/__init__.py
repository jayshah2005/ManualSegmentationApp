"""Format registry: ``open_source(path)`` picks the right loader by extension."""
from __future__ import annotations

from pathlib import Path

from .base import ImageSource, LoadError, SourceInfo
from .envi import EnviSource
from .mat import MatSource
from .npy import NpySource
from .rgb import RgbSource
from .tiff import TiffSource

RGB_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
TIFF_EXTS = {".tif", ".tiff"}
NPY_EXTS = {".npy", ".npz"}
MAT_EXTS = {".mat"}
ENVI_EXTS = {".hdr"}
SUPPORTED_EXTS = RGB_EXTS | TIFF_EXTS | NPY_EXTS | MAT_EXTS | ENVI_EXTS


def open_source(path: Path | str) -> ImageSource:
    p = Path(path)
    ext = p.suffix.lower()
    if ext in RGB_EXTS:
        return RgbSource(p)
    if ext in TIFF_EXTS:
        return TiffSource(p)
    if ext in NPY_EXTS:
        return NpySource(p)
    if ext in MAT_EXTS:
        return MatSource(p)
    if ext in ENVI_EXTS:
        return EnviSource(p)
    raise LoadError(f"Unsupported file type: {p.name}")


__all__ = ["ImageSource", "LoadError", "SourceInfo", "SUPPORTED_EXTS", "open_source"]
