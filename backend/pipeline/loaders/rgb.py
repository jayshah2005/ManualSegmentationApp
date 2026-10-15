"""Photos: PNG, JPG, BMP, WebP via OpenCV (works with non-ASCII paths)."""
from __future__ import annotations

import cv2
import numpy as np

from .base import ImageSource, LoadError, SourceInfo


class RgbSource(ImageSource):
    kind = "rgb"

    def __init__(self, path) -> None:
        super().__init__(path)
        self.format = self.path.suffix.lower().lstrip(".").replace("jpeg", "jpg")

    def read_cube(self) -> np.ndarray:
        try:
            data = np.fromfile(str(self.path), dtype=np.uint8)
        except OSError as exc:
            raise LoadError(f"Cannot read {self.path.name}: {exc}") from exc
        # JPEG/WebP carry an EXIF orientation that only IMREAD_COLOR applies (phone photos!).
        # PNG/BMP keep IMREAD_UNCHANGED so 16-bit and grayscale data survive.
        exif_aware = self.format in ("jpg", "webp")
        img = cv2.imdecode(data, cv2.IMREAD_COLOR if exif_aware else cv2.IMREAD_UNCHANGED)
        if img is None:
            raise LoadError(f"{self.path.name} is not a readable image")
        if img.ndim == 2:
            return img[:, :, None]
        if img.shape[2] == 4:  # drop alpha, keep colour
            img = img[:, :, :3]
        return np.ascontiguousarray(img[:, :, ::-1])  # BGR -> RGB

    def _compute_info(self) -> SourceInfo:
        cube = self.read_cube()
        return SourceInfo(
            kind="rgb",
            format=self.format,
            width=cube.shape[1],
            height=cube.shape[0],
            bands=cube.shape[2],
            dtype=str(cube.dtype),
        )
