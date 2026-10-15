"""Common interface for every supported image / cube format.

All loaders return arrays shaped ``(H, W, B)`` in the file's native dtype.
``kind`` decides how the app treats the file:

- ``rgb``  — ordinary photo (PNG/JPG/BMP/WebP/1- or 3-channel TIFF)
- ``cube`` — multispectral / hyperspectral data (ENVI, multiband TIFF, NPY, MAT)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


class LoadError(Exception):
    """The file exists but cannot be read as an image or cube."""


@dataclass
class SourceInfo:
    kind: str  # "rgb" | "cube"
    format: str  # "png" | "jpg" | "tiff" | "envi" | "npy" | "mat" ...
    width: int
    height: int
    bands: int
    dtype: str
    wavelengths: list[float] | None = None
    notes: list[str] = field(default_factory=list)


class ImageSource(ABC):
    kind = "rgb"
    format = ""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._info: SourceInfo | None = None

    @abstractmethod
    def _compute_info(self) -> SourceInfo: ...

    def info(self) -> SourceInfo:
        """Cached metadata (reading a big image just for its shape is slow)."""
        if self._info is None:
            self._info = self._compute_info()
        return self._info

    @abstractmethod
    def read_cube(self) -> np.ndarray:
        """Whole image as ``(H, W, B)``."""

    def read_bands(self, indices: list[int]) -> np.ndarray:
        """Selected bands as ``(H, W, len(indices))``. Override to avoid reading all."""
        return np.ascontiguousarray(self.read_cube()[:, :, indices])
