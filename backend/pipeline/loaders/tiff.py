"""TIFF: plain RGB/gray photos or multiband (multispectral) rasters."""
from __future__ import annotations

import numpy as np
import tifffile

from .base import ImageSource, LoadError, SourceInfo

_BAND_AXES = set("SQIZTC")


def _to_hwb(arr: np.ndarray, axes: str) -> np.ndarray:
    """Normalise whatever layout tifffile reports to ``(H, W, B)``."""
    axes = axes.upper()
    if axes.endswith("YXS") and arr.ndim == 3:
        return arr
    if axes == "YX":
        return arr[:, :, None]
    if arr.ndim == 3 and axes.endswith("YX") and axes[0] in _BAND_AXES:
        return np.moveaxis(arr, 0, -1)  # (B, H, W) -> (H, W, B)
    if arr.ndim == 3:  # unknown axes: smallest dim is the band axis
        b_axis = int(np.argmin(arr.shape))
        return np.moveaxis(arr, b_axis, -1)
    raise LoadError(f"Unsupported TIFF layout {axes!r} with shape {arr.shape}")


class TiffSource(ImageSource):
    format = "tiff"

    def __init__(self, path) -> None:
        super().__init__(path)
        self._kind: str | None = None

    @property
    def kind(self) -> str:  # type: ignore[override]
        if self._kind is None:
            self._kind = self._detect_kind()
        return self._kind

    def _detect_kind(self) -> str:
        try:
            with tifffile.TiffFile(str(self.path)) as tf:
                page = tf.pages[0]
                samples = page.samplesperpixel
                n_pages = len(tf.pages)
                has_alpha = bool(page.extrasamples)
        except Exception as exc:  # noqa: BLE001 - tifffile raises many types
            raise LoadError(f"{self.path.name} is not a readable TIFF: {exc}") from exc
        if n_pages == 1 and (samples in (1, 3) or (samples == 4 and has_alpha)):
            return "rgb"
        return "cube"

    def read_cube(self) -> np.ndarray:
        try:
            with tifffile.TiffFile(str(self.path)) as tf:
                series = tf.series[0]
                arr = _to_hwb(series.asarray(), series.axes)
        except LoadError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise LoadError(f"Cannot read {self.path.name}: {exc}") from exc
        if self.kind == "rgb" and arr.shape[2] == 4:
            arr = arr[:, :, :3]
        return np.ascontiguousarray(arr)

    def _compute_info(self) -> SourceInfo:
        cube = self.read_cube()
        return SourceInfo(
            kind=self.kind,
            format="tiff",
            width=cube.shape[1],
            height=cube.shape[0],
            bands=cube.shape[2],
            dtype=str(cube.dtype),
        )
