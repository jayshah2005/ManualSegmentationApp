"""MATLAB .mat files: v5/v7 via SciPy, v7.3 (HDF5) via h5py."""
from __future__ import annotations

import numpy as np

from .base import ImageSource, LoadError, SourceInfo
from .npy import orient_hwb


def _best_array(items: dict[str, np.ndarray]) -> np.ndarray:
    candidates = {
        k: v
        for k, v in items.items()
        if isinstance(v, np.ndarray) and v.ndim in (2, 3) and v.dtype.kind in "uifb"
    }
    if not candidates:
        raise LoadError("No numeric 2-D/3-D variable found in the .mat file")
    return candidates[max(candidates, key=lambda k: candidates[k].size)]


def _is_hdf5(path) -> bool:
    with open(path, "rb") as f:  # HDF5 magic; MATLAB v7.3 files are HDF5 with a text header
        head = f.read(512)
    return b"\x89HDF\r\n\x1a\n" in head or head.startswith(b"MATLAB 7.3")


class MatSource(ImageSource):
    kind = "cube"
    format = "mat"

    def read_cube(self) -> np.ndarray:
        try:
            if _is_hdf5(self.path):  # MATLAB v7.3
                arr = self._read_v73()
            else:
                from scipy.io import loadmat

                raw = loadmat(str(self.path))
                arr = _best_array({k: v for k, v in raw.items() if not k.startswith("__")})
        except LoadError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise LoadError(f"Cannot read {self.path.name}: {exc}") from exc
        return np.ascontiguousarray(orient_hwb(arr))

    def _read_v73(self) -> np.ndarray:
        import h5py

        try:
            with h5py.File(str(self.path), "r") as f:
                found: dict[str, np.ndarray] = {}

                def visit(name, obj):
                    if isinstance(obj, h5py.Dataset) and obj.ndim in (2, 3):
                        found[name] = obj[()]

                f.visititems(visit)
        except OSError as exc:
            raise LoadError(f"Cannot read {self.path.name}: {exc}") from exc
        # MATLAB stores column-major, so h5py shows axes reversed.
        return _best_array(found).T

    def _compute_info(self) -> SourceInfo:
        cube = self.read_cube()
        return SourceInfo(
            kind="cube",
            format="mat",
            width=int(cube.shape[1]),
            height=int(cube.shape[0]),
            bands=int(cube.shape[2]),
            dtype=str(cube.dtype),
        )
