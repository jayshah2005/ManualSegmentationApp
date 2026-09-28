"""Auto seed points for SAM2 from NDVI peaks on the hyperspectral cube."""
from __future__ import annotations

import cv2
import numpy as np
from skimage.feature import peak_local_max

from backend.config import MAX_AUTO_CENTROIDS


def get_sam2_seed_prompts(
    hsi_cube: np.ndarray, ndvi_thresh: float = 0.4, min_dist: int = 30
) -> list[tuple[int, int]]:
    """Return ``[(x, y), ...]`` positive prompts, or ``[]`` if auto peaks look unreliable.

    Specim IQ band indices: NIR≈180, red≈100. Too many peaks usually means the
    threshold is wrong, so we bail and let the user place seeds manually.
    """
    nir_band = hsi_cube[:, :, 180]
    red_band = hsi_cube[:, :, 100]
    numerator = nir_band.astype(np.float32) - red_band.astype(np.float32)
    denominator = nir_band.astype(np.float32) + red_band.astype(np.float32) + 1e-6
    ndvi = numerator / denominator

    binary = (ndvi > ndvi_thresh).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    coords = peak_local_max(dist_transform, min_distance=min_dist, labels=binary)
    # peak_local_max returns (row, col) == (y, x)
    seeds = [(int(c[1]), int(c[0])) for c in coords]
    if len(seeds) > MAX_AUTO_CENTROIDS:
        return []
    return seeds