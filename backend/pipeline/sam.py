"""SAM 2 prompts → one cleaned binary mask per object.

An object is described by positive/negative points and/or a box. Only the
object being edited is re-predicted; the image embedding is cached by the
caller (``ModelRegistry.ensure_image``).
"""
from __future__ import annotations

import cv2
import numpy as np

Point = tuple[int, int, int]  # x, y, label (1 = include, 0 = exclude)
Box = tuple[int, int, int, int]  # x0, y0, x1, y1


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Keep the largest blob and close small holes in a SAM binary mask."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return mask

    largest_contour = max(contours, key=cv2.contourArea)
    cleaned = np.zeros_like(mask)
    cv2.drawContours(cleaned, [largest_contour], -1, 255, thickness=cv2.FILLED)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    return cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)


def predict_object(predictor, points: list[Point], box: Box | None) -> np.ndarray:
    """Run SAM for one object. The image must already be set on ``predictor``."""
    coords = labels = None
    if points:
        coords = np.array([[x, y] for x, y, _ in points], dtype=np.float32)
        labels = np.array([lab for _, _, lab in points], dtype=np.int32)
    box_arr = np.array(box, dtype=np.float32) if box else None
    mask, _, _ = predictor.predict(
        point_coords=coords,
        point_labels=labels,
        box=box_arr,
        multimask_output=False,
    )
    binary = (mask[0] > 0).astype(np.uint8) * 255
    return clean_mask(binary)


def mask_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    ys, xs = np.where(mask == 255)
    if len(ys) == 0:
        return None
    return float(xs.mean()), float(ys.mean())
