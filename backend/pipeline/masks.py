"""Mask morph ops used at export time and for border suggestions.

Binary masks are uint8 with 0 = background and 255 = foreground.
"""
from __future__ import annotations

import cv2
import numpy as np


def disk_kernel(radius: int) -> np.ndarray:
    """Binary disk SE matching the UI border test (``dx*dx + dy*dy <= r*r``).

    Must stay in sync with ``isKeptAfterShrink`` in
    ``frontend/src/canvas/maskRegion.ts`` so Save matches on-screen borders.
    """
    r = max(0, int(radius))
    if r <= 0:
        return np.ones((1, 1), dtype=np.uint8)
    y, x = np.ogrid[-r : r + 1, -r : r + 1]
    return ((x * x + y * y) <= r * r).astype(np.uint8)


def erode_mask(mask: np.ndarray, shrink_px: int = 0) -> np.ndarray:
    """Pull the mask edge inward by ``shrink_px`` (removes a border fringe).

    Uses the same disk kernel as the React border preview (not OpenCV's
    ``MORPH_ELLIPSE``, which differs by ~1 px on some edges).
    """
    r = max(0, int(shrink_px))
    if r <= 0:
        return mask.copy()
    # Border constant 0: disk extending outside the image fails, same as the UI.
    return cv2.erode(mask, disk_kernel(r), iterations=1, borderType=cv2.BORDER_CONSTANT, borderValue=0)


def apply_shrink_preserving_edits(
    edited_mask: np.ndarray,
    sam_mask: np.ndarray | None = None,
    shrink_px: int = 0,
    brush_keep: np.ndarray | None = None,
) -> np.ndarray:
    """Apply border shrink to the original SAM mask, then layer brush edits.

    Order:
    1. Start from original SAM
    2. Erode by ``shrink_px`` (border)
    3. Keep user brush *additions* and *brush_keep* (reclaimed fringe / paint);
       honor user *erasures*

    Brush strokes are never re-fringed when the border changes.
    """
    edited = ((edited_mask > 0).astype(np.uint8)) * 255
    if sam_mask is None:
        return erode_mask(edited, shrink_px)

    sam = ((sam_mask > 0).astype(np.uint8)) * 255
    additions = ((edited == 255) & (sam == 0)).astype(np.uint8) * 255
    erasures = (sam == 255) & (edited == 0)

    working = erode_mask(sam, shrink_px)
    if np.any(additions):
        working = np.maximum(working, additions)
    if brush_keep is not None:
        keep = ((brush_keep > 0) & (edited == 255)).astype(np.uint8) * 255
        if np.any(keep):
            working = np.maximum(working, keep)
    working[erasures] = 0
    return working


def mask_bbox(mask: np.ndarray):
    """Return ``(ymin, ymax, xmin, xmax)`` or None if empty."""
    y_indices, x_indices = np.where(mask == 255)
    if len(y_indices) == 0:
        return None
    return (
        int(y_indices.min()),
        int(y_indices.max()),
        int(x_indices.min()),
        int(x_indices.max()),
    )


def suggest_mask_shrink(mask: np.ndarray, min_px: int = 2, max_px: int = 30) -> int:
    """Heuristic border width from leaf size and edge irregularity.

    Jagged / non-circular SAM edges get a wider suggested shrink.
    """
    bbox = mask_bbox(mask)
    if bbox is None:
        return min_px
    ymin, ymax, xmin, xmax = bbox
    h, w = ymax - ymin + 1, xmax - xmin + 1
    min_side = max(1, min(h, w))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return min_px
    cnt = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(cnt))
    peri = float(cv2.arcLength(cnt, True))
    if area <= 0 or peri <= 0:
        return min_px

    circularity = float(np.clip(4.0 * np.pi * area / (peri * peri), 0.0, 1.0))
    hull = cv2.convexHull(cnt)
    hull_area = float(cv2.contourArea(hull)) or area
    solidity = float(np.clip(area / hull_area, 0.0, 1.0))

    base = 0.035 * min_side
    if circularity < 0.45 or solidity < 0.85:
        base *= 1.6
    elif circularity > 0.7 and solidity > 0.95:
        base *= 0.7

    suggested = int(round(base))
    return int(np.clip(suggested, min_px, min(max_px, max(min_px, min_side // 6))))


def crop_masked_leaf(hsi_cube, mask, shrink_px=0, sam_mask=None, brush_keep=None):
    """Apply shrink, zero outside the mask, crop to bbox — what Save writes as ENVI."""
    working = apply_shrink_preserving_edits(
        mask, sam_mask=sam_mask, shrink_px=shrink_px, brush_keep=brush_keep
    )
    bbox = mask_bbox(working)
    if bbox is None:
        return None
    ymin, ymax, xmin, xmax = bbox
    masked_hsi = hsi_cube * (working[:, :, np.newaxis] > 0)
    return masked_hsi[ymin : ymax + 1, xmin : xmax + 1, :]


def rgb_crop_preview(rgb_image, mask, shrink_px=0, sam_mask=None, brush_keep=None):
    """RGB preview matching ``crop_masked_leaf`` geometry (for UI thumbs / fullscreen)."""
    working = apply_shrink_preserving_edits(
        mask, sam_mask=sam_mask, shrink_px=shrink_px, brush_keep=brush_keep
    )
    bbox = mask_bbox(working)
    if bbox is None:
        return None
    ymin, ymax, xmin, xmax = bbox
    masked = rgb_image.copy()
    masked[working == 0] = 0
    return masked[ymin : ymax + 1, xmin : xmax + 1]


def encode_mask_png(mask: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", (mask > 0).astype(np.uint8) * 255)
    if not ok:
        raise ValueError("Failed to encode mask PNG")
    return buf.tobytes()


def decode_mask_png(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("Failed to decode mask PNG")
    return ((img > 127).astype(np.uint8)) * 255
