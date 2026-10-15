"""NumPy .npy / .npz arrays."""
from __future__ import annotations

import numpy as np

from .base import ImageSource, LoadError, SourceInfo


def orient_hwb(arr: np.ndarray) -> np.ndarray:
    """Return ``(H, W, B)``. Accepts 2-D, ``(H, W, B)`` or channels-first ``(B, H, W)``.

    A 3-D array is treated as channels-first only when its first axis is much
    smaller than both spatial axes (e.g. 200 x 1024 x 1024).
    """
    if arr.ndim == 2:
        return arr[:, :, None]
    if arr.ndim != 3:
        raise LoadError(f"Expected a 2-D or 3-D array, got shape {arr.shape}")
    if arr.shape[0] < 0.2 * min(arr.shape[1], arr.shape[2]) and arr.shape[0] < arr.shape[2]:
        return np.moveaxis(arr, 0, -1)
    return arr


class NpySource(ImageSource):
    kind = "cube"
    format = "npy"

    def _load(self, mmap: bool = False):
        try:
            data = np.load(str(self.path), mmap_mode="r" if mmap else None, allow_pickle=False)
        except Exception as exc:  # noqa: BLE001
            raise LoadError(f"Cannot read {self.path.name}: {exc}") from exc
        if isinstance(data, np.lib.npyio.NpzFile):
            with data:
                keys = [k for k in data.files if data[k].ndim in (2, 3)]
                if not keys:
                    raise LoadError(f"{self.path.name} has no 2-D/3-D arrays")
                best = max(keys, key=lambda k: data[k].size)
                return orient_hwb(np.asarray(data[best]))
        return orient_hwb(data)

    def _compute_info(self) -> SourceInfo:
        arr = self._load(mmap=True)
        return SourceInfo(
            kind="cube",
            format="npy",
            width=int(arr.shape[1]),
            height=int(arr.shape[0]),
            bands=int(arr.shape[2]),
            dtype=str(arr.dtype),
        )

    def read_cube(self) -> np.ndarray:
        return np.ascontiguousarray(self._load())

    def read_bands(self, indices: list[int]) -> np.ndarray:
        arr = self._load(mmap=True)
        return np.ascontiguousarray(arr[:, :, indices])
