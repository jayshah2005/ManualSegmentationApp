"""Shared helpers for API routers: mask encoding, response shaping, SAM runs.

``session_response`` is the contract with the React app; keep field names
stable (camelCase).
"""
from __future__ import annotations

import base64
from typing import Any

import cv2
import numpy as np
from fastapi import HTTPException

from backend.models import ModelRegistry
from backend.pipeline import masks as masks_mod
from backend.pipeline import progress as progress_mod
from backend.pipeline import sam as sam_mod
from backend.pipeline.sam import Box
from backend.schemas import BoxIn, PointIn
from backend.session import ObjectState, Session, SessionManager
from backend.settings import Settings


def encode_jpeg(rgb: np.ndarray, quality: int = 90) -> bytes:
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()


def mask_b64(mask: np.ndarray) -> str:
    return base64.b64encode(masks_mod.encode_mask_png(mask)).decode("ascii")


def decode_mask_b64(data: str) -> np.ndarray:
    try:
        return masks_mod.decode_mask_png(base64.b64decode(data))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def object_payload(obj: ObjectState) -> dict[str, Any]:
    """One object with its masks. The browser draws thumbnails itself from these."""
    mask = obj.edited_mask
    centroid = sam_mod.mask_centroid(mask) if mask is not None else None
    zeros = np.zeros_like(mask) if mask is not None else None
    return {
        "id": obj.id,
        "label": obj.label,
        "shrink": obj.shrink,
        "points": [{"x": x, "y": y, "label": lab} for x, y, lab in obj.points],
        "box": (
            {"x0": obj.box[0], "y0": obj.box[1], "x1": obj.box[2], "y1": obj.box[3]}
            if obj.box else None
        ),
        "centroid": {"x": centroid[0], "y": centroid[1]} if centroid else None,
        "maskPngBase64": mask_b64(mask) if mask is not None else None,
        "samMaskPngBase64": mask_b64(obj.sam_mask) if obj.sam_mask is not None else None,
        "brushKeepPngBase64": mask_b64(obj.brush_keep if obj.brush_keep is not None else zeros)
        if zeros is not None else None,
    }


def session_response(session: Session, settings: Settings) -> dict[str, Any]:
    """Full snapshot the React app keeps in its store after most mutations."""
    status = "Pending"
    if settings.outputDir:
        try:
            status = progress_mod.sample_status(
                progress_mod.load_progress(settings.outputDir), session.sample_key
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    info = session.info
    return {
        "sampleKey": session.sample_key,
        "name": session.sample.name if session.sample else "",
        "status": status,
        "width": session.width,
        "height": session.height,
        "nativeWidth": session.native_hw[1],
        "nativeHeight": session.native_hw[0],
        "kind": info.kind if info else "rgb",
        "format": info.format if info else "",
        "bands": info.bands if info else 3,
        "bandsUsed": session.bands_used,
        "objects": [object_payload(o) for o in session.objects],
    }


def ensure_session_loaded(mgr: SessionManager) -> Session:
    session = mgr.get()
    if session.rgb_image is None or not session.sample_key:
        raise HTTPException(status_code=400, detail="No image is open")
    return session


def assert_sample_key(session: Session, sample_key: str | None) -> None:
    """Reject stale client mutations that target a sample the server already left."""
    if session.rgb_image is None or not session.sample_key:
        raise HTTPException(status_code=400, detail="No image is open")
    if sample_key is not None and sample_key != session.sample_key:
        raise HTTPException(
            status_code=409,
            detail=f"Image changed (client={sample_key}, server={session.sample_key})",
        )


def clamp_prompts(
    session: Session, points: list[PointIn], box: BoxIn | None
) -> tuple[list[tuple[int, int, int]], Box | None]:
    w, h = session.width, session.height
    pts = [(min(max(p.x, 0), w - 1), min(max(p.y, 0), h - 1), int(p.label)) for p in points]
    out_box: Box | None = None
    if box is not None:
        x0, x1 = sorted((box.x0, box.x1))
        y0, y1 = sorted((box.y0, box.y1))
        out_box = (min(max(x0, 0), w - 1), min(max(y0, 0), h - 1), min(max(x1, 0), w - 1), min(max(y1, 0), h - 1))
        if out_box[2] - out_box[0] < 2 or out_box[3] - out_box[1] < 2:
            raise HTTPException(status_code=400, detail="Box is too small")
    if not pts and out_box is None:
        raise HTTPException(status_code=400, detail="Add at least one point or a box")
    if pts and not any(p[2] == 1 for p in pts) and out_box is None:
        raise HTTPException(status_code=400, detail="Add at least one include point (or a box)")
    return pts, out_box


def run_object(session: Session, obj: ObjectState, models: ModelRegistry, settings: Settings) -> None:
    """(Re)predict ``obj`` from its prompts. Brush edits and border reset for this object only."""
    predictor = models.get_sam2(settings.samModel, settings.device)
    with models.sam_lock:
        models.ensure_image(predictor, session.image_token, session.rgb_image)
        mask = sam_mod.predict_object(predictor, obj.points, obj.box)
    obj.sam_mask = mask
    obj.reset_edits()
    obj.shrink = 0
