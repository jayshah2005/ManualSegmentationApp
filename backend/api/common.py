"""Shared helpers for API routers: encode masks, build session JSON, run OCR/SAM.

``session_response`` is the contract with the React app — keep field names stable
(camelCase). ``leaf_payload`` walks *display* order but embeds ``maskIndex`` so
the client can paint the correct ``Uint8Array``.
"""
from __future__ import annotations

import base64
from typing import Any

import cv2
import numpy as np
from fastapi import HTTPException

from backend.config import MAX_AUTO_CENTROIDS
from backend.models import ModelRegistry
from backend.pipeline import masks as masks_mod
from backend.pipeline import ocr as ocr_mod
from backend.pipeline import sam as sam_mod
from backend.pipeline import save as save_mod
from backend.session import Session, SessionManager


def encode_jpeg(rgb: np.ndarray, quality: int = 90) -> bytes:
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()


def mask_b64(mask: np.ndarray) -> str:
    return base64.b64encode(masks_mod.encode_mask_png(mask)).decode("ascii")


def decode_mask_b64(data: str) -> np.ndarray:
    raw = base64.b64decode(data)
    return masks_mod.decode_mask_png(raw)


def leaf_payload(session: Session) -> list[dict[str, Any]]:
    """Per-leaf dicts for the UI (display order). ``maskIndex`` indexes mask arrays."""
    leaves: list[dict[str, Any]] = []
    if not session.sorted_centroids or session.sam_masks is None:
        return leaves
    edited = session.edited_masks or session.sam_masks
    for display_idx, (old_idx, cy, cx) in enumerate(session.sorted_centroids):
        label = (
            session.sublabels[display_idx]
            if display_idx < len(session.sublabels)
            else ""
        )
        shrink = (
            int(session.leaf_shrinks[display_idx])
            if display_idx < len(session.leaf_shrinks)
            else 0
        )
        if shrink < 0:
            shrink = 0
        mask = edited[old_idx]
        preview = masks_mod.rgb_crop_preview(
            session.rgb_image,
            mask,
            shrink_px=shrink,
            sam_mask=session.sam_masks[old_idx],
        )
        thumb_b64 = None
        if preview is not None:
            small = preview
            h, w = small.shape[:2]
            scale = min(1.0, 220.0 / max(h, w))
            if scale < 0.999:
                small = cv2.resize(
                    small,
                    (max(1, int(w * scale)), max(1, int(h * scale))),
                    interpolation=cv2.INTER_AREA,
                )
            elif scale > 1.001:
                small = cv2.resize(
                    small,
                    (max(1, int(w * min(scale, 4.0))), max(1, int(h * min(scale, 4.0)))),
                    interpolation=cv2.INTER_NEAREST,
                )
            thumb_b64 = base64.b64encode(encode_jpeg(small, 85)).decode("ascii")
        leaves.append(
            {
                "displayIndex": display_idx,
                "maskIndex": old_idx,
                "label": label,
                "centroid": {"x": float(cx), "y": float(cy)},
                "shrink": shrink,
                "maskPngBase64": mask_b64(mask),
                # Original SAM mask so the client can preview border without
                # fringing brush additions (mirrors apply_shrink_preserving_edits).
                "samMaskPngBase64": mask_b64(session.sam_masks[old_idx]),
                "brushKeepPngBase64": mask_b64(
                    session.brush_keeps[old_idx]
                    if session.brush_keeps is not None
                    and old_idx < len(session.brush_keeps)
                    else np.zeros_like(mask)
                ),
                "thumbnailJpegBase64": thumb_b64,
            }
        )
    return leaves


def session_response(session: Session) -> dict[str, Any]:
    """Full snapshot the React app keeps in Zustand after most mutations."""
    try:
        progress = save_mod.load_progress()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    status = progress.get(session.sample_key, {}).get("status", "Pending")
    return {
        "vineType": session.vine_type,
        "folder": session.folder,
        "sampleKey": session.sample_key,
        "status": status,
        "width": session.width,
        "height": session.height,
        "seeds": [{"x": x, "y": y} for x, y in session.seeds],
        "mainLabel": session.main_label,
        "sublabels": session.sublabels,
        "ocrMeta": session.ocr_meta,
        "ndviThresh": session.ndvi_thresh,
        "minDistance": session.min_distance,
        "maxAutoCentroids": MAX_AUTO_CENTROIDS,
        "leaves": leaf_payload(session),
        "hasMasks": session.sam_masks is not None and len(session.sam_masks) > 0,
    }


def ensure_session_loaded(mgr: SessionManager) -> Session:
    session = mgr.get()
    if session.rgb_image is None or not session.sample_key:
        raise HTTPException(status_code=400, detail="No sample loaded")
    return session


def assert_sample_key(session: Session, sample_key: str | None) -> None:
    """Reject stale client mutations that target a sample the server already left."""
    if session.rgb_image is None or not session.sample_key:
        raise HTTPException(status_code=400, detail="No sample loaded")
    if sample_key is not None and sample_key != session.sample_key:
        raise HTTPException(
            status_code=409,
            detail=f"Sample changed (client={sample_key}, server={session.sample_key})",
        )


def run_sam(session: Session, models: ModelRegistry) -> None:
    """Recompute masks from current seeds. Border shrinks always reset to 0."""
    predictor = models.get_sam2()
    session.sam_busy = True
    try:
        if not session.seeds:
            session.sam_masks = []
            session.edited_masks = []
            session.brush_keeps = []
            session.centroids = []
            session.sorted_centroids = []
            session.leaf_shrinks = []
            return
        with models.sam_lock:
            masks, centroids = sam_mod.run_sam2_inference(
                predictor, session.rgb_image, session.seeds
            )
        session.sam_masks = masks
        session.edited_masks = [m.copy() for m in masks]
        session.brush_keeps = [np.zeros_like(m) for m in masks]
        session.centroids = centroids
        img_h, img_w = session.rgb_image.shape[:2]
        session.sorted_centroids = sam_mod.sort_leaf_centroids(centroids, img_h, img_w)
        n = len(session.sorted_centroids)
        # Never auto-suggest: borders stay 0 until the user edits or clicks Suggest.
        session.leaf_shrinks = [0] * n
        # Pad/truncate to leaf count; leave unknown labels empty (no #1 placeholders).
        labels = list(session.sublabels)
        while len(labels) < n:
            labels.append("")
        session.sublabels = labels[:n]
    finally:
        session.sam_busy = False


def apply_ocr(
    session: Session,
    models: ModelRegistry,
    force: bool = False,
    *,
    use_last_main: bool = True,
) -> None:
    """Fill main/sublabels from the sticky note when OCR succeeds.

    Main-label priority for batch curation (``use_last_main=True``):
    1. ``last_main_label`` (typed / saved on a prior sample in this vine)
    2. Fresh OCR folder tag
    3. Empty

    Pass ``use_last_main=False`` for explicit Re-OCR so a new sticky tag wins.
    Sublabels still come from OCR when forced or when none are set yet.
    """
    reader = models.get_ocr()
    auto_label, auto_sublabels = ocr_mod.extract_labels(session.png_img, reader)
    used_previous_main = False
    ocr_main = auto_label[0] if auto_label else ""

    if use_last_main and session.last_main_label:
        # Keep the established folder name across Save → next sample.
        detected_main = session.last_main_label
        used_previous_main = ocr_main != session.last_main_label
    elif ocr_main:
        detected_main = ocr_main
        session.last_main_label = ocr_main
    else:
        detected_main = ""

    session.ocr_meta = {
        "foundStickyNote": bool(auto_label or auto_sublabels),
        "foundMainLabel": bool(auto_label),
        "usedPreviousMain": used_previous_main,
        "detectedMain": detected_main,
        "ocrMain": ocr_main,
        "detectedSublabels": auto_sublabels,
    }
    if force or not session.main_label:
        session.main_label = detected_main
    if force or not session.sublabels:
        session.sublabels = list(auto_sublabels)
