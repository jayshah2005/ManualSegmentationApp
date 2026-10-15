"""ENVI (.hdr + data file) — Specim IQ and most hyperspectral cameras."""
from __future__ import annotations

import numpy as np
import spectral

from .base import ImageSource, LoadError, SourceInfo


class EnviSource(ImageSource):
    kind = "cube"
    format = "envi"

    def _open(self):
        try:
            return spectral.envi.open(str(self.path))
        except Exception as exc:  # noqa: BLE001 - spectral raises many types
            raise LoadError(
                f"Cannot open ENVI header {self.path.name}: {exc} "
                "(is the data file next to the .hdr?)"
            ) from exc

    def _compute_info(self) -> SourceInfo:
        img = self._open()
        centers = getattr(img.bands, "centers", None)
        return SourceInfo(
            kind="cube",
            format="envi",
            width=int(img.ncols),
            height=int(img.nrows),
            bands=int(img.nbands),
            dtype=str(np.dtype(img.dtype)),
            wavelengths=[float(c) for c in centers] if centers else None,
            sensor=str(getattr(img, "metadata", {}).get("sensor type") or "") or None,
        )

    def read_cube(self) -> np.ndarray:
        return np.ascontiguousarray(np.asarray(self._open().load()))

    def read_bands(self, indices: list[int]) -> np.ndarray:
        # Reads only the requested bands from disk (cubes can be GBs).
        return np.ascontiguousarray(self._open().read_bands(indices))
