"""Turn any source into the 8-bit RGB picture SAM and the canvas work on.

SAM only ever sees this picture; the full cube is re-read at export time.
"""
from __future__ import annotations

import cv2
import numpy as np

from backend.pipeline.loaders import ImageSource, SourceInfo
from backend.settings import DisplaySettings, OrientationSettings

# Visible-light targets (nm) used to pick R, G, B bands from wavelength metadata.
_RGB_NM = (640.0, 550.0, 460.0)


def auto_bands(bands: int, wavelengths: list[float] | None) -> list[int]:
    """Pick ``[R, G, B]`` band indices: nearest visible wavelengths, else spread out."""
    if bands <= 1:
        return [0, 0, 0]
    if bands == 2:
        return [1, 0, 0]
    if bands == 3:
        return [0, 1, 2]
    if wavelengths and len(wavelengths) == bands:
        w = np.asarray(wavelengths, dtype=np.float64)
        # Wavelengths may be in micrometres; normalise to nm.
        if np.nanmax(w) < 20:
            w = w * 1000.0
        if np.nanmin(w) <= 700 and np.nanmax(w) >= 450:
            return [int(np.argmin(np.abs(w - t))) for t in _RGB_NM]
    return [bands - 1, bands // 2, 0]


def resolve_bands(bands: int, wavelengths: list[float] | None, cfg: DisplaySettings) -> list[int]:
    if cfg.bandMode == "manual" and len(cfg.bands) == 3:
        return [min(max(int(b), 0), bands - 1) for b in cfg.bands]
    return auto_bands(bands, wavelengths)


def effective_orientation(info: SourceInfo, cfg: OrientationSettings) -> OrientationSettings:
    """The user's orientation plus automatic corrections for known cameras."""
    if cfg.autoUpright and info.sensor and "specim iq" in info.sensor.lower():
        return cfg.model_copy(update={"rotate": (cfg.rotate + 90) % 360})
    return cfg


def apply_orientation(arr: np.ndarray, cfg: OrientationSettings) -> np.ndarray:
    """Rotate clockwise then flip. Works on ``(H, W)`` and ``(H, W, B)`` arrays."""
    out = arr
    if cfg.rotate:
        out = np.rot90(out, k=-(cfg.rotate // 90), axes=(0, 1))
    if cfg.flipH:
        out = out[:, ::-1]
    if cfg.flipV:
        out = out[::-1]
    return np.ascontiguousarray(out)


def stretch_to_uint8(arr: np.ndarray, low: float, high: float) -> np.ndarray:
    """Percentile stretch over all channels together (keeps colour balance)."""
    if arr.dtype == np.uint8:
        return arr
    data = arr.astype(np.float32)
    finite = np.isfinite(data)
    if not finite.any():
        return np.zeros(arr.shape, dtype=np.uint8)
    sample = data[::4, ::4][finite[::4, ::4]]
    if sample.size == 0:
        sample = data[finite]
    lo, hi = np.percentile(sample, [low, high])
    if hi <= lo:
        hi = lo + 1.0
    scaled = np.clip((np.nan_to_num(data, nan=lo) - lo) / (hi - lo), 0.0, 1.0)
    return (scaled * 255.0 + 0.5).astype(np.uint8)


def limit_size(rgb: np.ndarray, max_size: int) -> np.ndarray:
    """Shrink so the longest side is at most ``max_size`` (0 = keep full size)."""
    h, w = rgb.shape[:2]
    if max_size <= 0 or max(h, w) <= max_size:
        return rgb
    scale = max_size / max(h, w)
    return cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


def oriented_size(width: int, height: int, cfg: OrientationSettings) -> tuple[int, int]:
    """``(height, width)`` of an image after ``cfg``'s rotation."""
    return (width, height) if cfg.rotate in (90, 270) else (height, width)


def build_display_rgb(
    source: ImageSource, display: DisplaySettings, orientation: OrientationSettings
) -> tuple[np.ndarray, list[int]]:
    """Return ``(uint8 RGB image (H, W, 3), band indices used)`` with orientation applied."""
    info = source.info()
    if info.kind == "rgb":
        used = [0, 1, 2] if info.bands >= 3 else [0, 0, 0]
        picked = source.read_cube()
        if picked.shape[2] == 1:
            picked = np.repeat(picked, 3, axis=2)
        rgb = picked[:, :, :3]
    else:
        used = resolve_bands(info.bands, info.wavelengths, display)
        rgb = source.read_bands(used)
    rgb = stretch_to_uint8(rgb, display.stretchLow, display.stretchHigh)
    return limit_size(apply_orientation(rgb, orientation), display.maxSize), used
