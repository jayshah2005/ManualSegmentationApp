"""SAM2 inference and leaf ordering for the curation UI.

Each seed becomes one binary mask. Centroids are then sorted into display order
(left column top→bottom, right column, then bottom-center sticky-note leaf).
That order is what the rail and ``displayIndex`` follow.
"""
from __future__ import annotations

import cv2
import numpy as np


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Keep the largest blob and close small holes in a SAM binary mask."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return mask

    largest_contour = max(contours, key=cv2.contourArea)
    cleaned = np.zeros_like(mask)
    cv2.drawContours(cleaned, [largest_contour], -1, 255, thickness=cv2.FILLED)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)
    return cleaned


def run_sam2_inference(sam2_predictor, rgb_image, seed_points):
    """One positive point prompt per seed → cleaned masks + centroids.

    Centroids are ``(mask_index, cy, cx)`` in image coordinates.
    """
    if not seed_points:
        return [], []

    sam2_predictor.set_image(rgb_image)
    masks = []
    centroids = []

    for cx, cy in seed_points:
        mask, _, _ = sam2_predictor.predict(
            point_coords=np.array([[cx, cy]]),
            point_labels=np.array([1]),
            multimask_output=False,
        )
        binary_mask = (mask[0] > 0).astype(np.uint8) * 255
        cleaned_binary_mask = clean_mask(binary_mask)
        masks.append(cleaned_binary_mask)

        y_indices, x_indices = np.where(cleaned_binary_mask == 255)
        if len(y_indices) > 0:
            centroids.append(
                (len(masks) - 1, float(np.mean(y_indices)), float(np.mean(x_indices)))
            )

    return masks, centroids


def sort_leaf_centroids(centroids, img_h: int, img_w: int):
    """Display order: left column, right column, then bottom-center (sticky note)."""
    mid_x = img_w / 2

    def leaf_position_key(item):
        _idx, cy, cx = item
        if cy > 0.65 * img_h and (0.35 * img_w < cx < 0.65 * img_w):
            return (2, 0)
        return (0, cy) if cx < mid_x else (1, cy)

    return sorted(centroids, key=leaf_position_key)
