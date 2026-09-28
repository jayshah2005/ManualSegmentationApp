"""Active sample routes: load cube → seeds/SAM → brush masks → shrink → save/skip.

Indexing reminder
-----------------
- ``displayIndex`` — UI leaf order (``session.sorted_centroids``). Labels + shrinks.
- ``maskIndex`` — index into ``sam_masks`` / ``edited_masks`` (seed / SAM order).

Most POSTs return a full ``session_response`` JSON blob that the React Zustand
store replaces (or partially merges). Brush painting stays client-side until
``POST /masks`` or Save syncs PNG masks up.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from backend.api import common
from backend.config import IMAGES
from backend.deps import get_models, get_session_mgr
from backend.models import ModelRegistry
from backend.pipeline import load as load_mod
from backend.pipeline import masks as masks_mod
from backend.pipeline import save as save_mod
from backend.pipeline import seeds as seeds_mod
from backend.schemas import (
    LabelsRequest,
    LoadRequest,
    MasksRequest,
    SaveRequest,
    SeedsRequest,
    ShrinkRequest,
)
from backend.session import Session, SessionManager

router = APIRouter(tags=["session"])


@router.post("/api/session/load")
def load_session(
    body: LoadRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
):
    """Open a sample: load PNG+cube, OCR sticky note, NDVI seeds, run SAM2."""
    if body.vineType not in IMAGES:
        raise HTTPException(status_code=400, detail=f"Unknown vine type: {body.vineType}")
    folders = load_mod.list_sample_folders(Path(IMAGES[body.vineType]))
    if body.folder not in folders:
        raise HTTPException(status_code=404, detail=f"Folder not found: {body.folder}")

    try:
        png_path, hdr_path = load_mod.sample_paths(body.vineType, body.folder, IMAGES)
        if not png_path.exists() or not hdr_path.exists():
            raise FileNotFoundError("PNG or HDR missing for sample")
        png_img, cube = load_mod.load_sample_data(png_path, hdr_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    rgb = load_mod.hsi_to_rgb(cube)

    with mgr.locked() as session:
        carry = (body.mainLabel or "").strip()
        # Carry main folder name within a vine; reset when switching vine types.
        if session.vine_type and session.vine_type != body.vineType:
            session.last_main_label = ""
        elif carry:
            session.last_main_label = carry
        elif session.main_label:
            session.last_main_label = session.main_label
        session.vine_type = body.vineType
        session.folder = body.folder
        session.sample_key = f"{body.vineType}/{body.folder}"
        session.png_img = png_img
        session.hsi_cube = cube
        session.rgb_image = rgb
        session.ndvi_thresh = body.ndviThresh
        session.min_distance = body.minDistance
        session.main_label = ""
        session.sublabels = []
        session.leaf_shrinks = []  # reset; run_sam will set all to 0
        common.apply_ocr(session, models, force=True)
        # Client-provided carry always wins over OCR for the main folder name.
        if carry:
            session.main_label = carry
            session.last_main_label = carry
        session.seeds = seeds_mod.get_sam2_seed_prompts(
            cube, body.ndviThresh, body.minDistance
        )
        common.run_sam(session, models)
        return common.session_response(session)


@router.get("/api/session/rgb")
def get_rgb(
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """JPEG of the HSI-derived RGB used on the canvas (not the camera PNG)."""
    session = common.ensure_session_loaded(mgr)
    common.assert_sample_key(session, sampleKey)
    data = common.encode_jpeg(session.rgb_image, 92)
    return Response(content=data, media_type="image/jpeg")


@router.get("/api/session")
def get_session(mgr: SessionManager = Depends(get_session_mgr)):
    """Current session snapshot (same shape as most mutation responses)."""
    session = common.ensure_session_loaded(mgr)
    return common.session_response(session)


@router.post("/api/session/seeds")
def update_seeds(
    body: SeedsRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
):
    """Replace seed list (from canvas clicks) and optionally re-run SAM."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        session.seeds = [(s.x, s.y) for s in body.seeds]
        if body.runSam:
            common.run_sam(session, models)
        return common.session_response(session)


@router.post("/api/session/reset-seeds")
def reset_seeds(
    ndviThresh: float | None = None,
    minDistance: int | None = None,
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
):
    """Recompute NDVI auto-seeds (may return empty → user places seeds by hand)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, sampleKey)
        if ndviThresh is not None:
            session.ndvi_thresh = ndviThresh
        if minDistance is not None:
            session.min_distance = minDistance
        session.seeds = seeds_mod.get_sam2_seed_prompts(
            session.hsi_cube, session.ndvi_thresh, session.min_distance
        )
        common.run_sam(session, models)
        return common.session_response(session)


@router.post("/api/session/ocr")
def update_ocr(
    body: LabelsRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
):
    """Manual label edits and/or force re-OCR of the sticky note."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        if body.redetect:
            # Fresh sticky read — do not force the previous sample's folder name.
            common.apply_ocr(session, models, force=True, use_last_main=False)
            if session.main_label:
                session.last_main_label = session.main_label
        if body.mainLabel is not None:
            session.main_label = body.mainLabel.strip()
            if session.main_label:
                session.last_main_label = session.main_label
        if body.sublabels is not None:
            session.sublabels = [s.strip() for s in body.sublabels]
        return common.session_response(session)


@router.post("/api/session/shrink")
def update_shrink(
    body: ShrinkRequest,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Set one leaf's border px, or resuggest all (heuristic from mask shape)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        if session.sam_masks is None or not session.sorted_centroids:
            raise HTTPException(status_code=400, detail="No masks to shrink")
        edited = session.edited_masks or session.sam_masks
        if body.resuggest:
            session.leaf_shrinks = [
                masks_mod.suggest_mask_shrink(edited[old_idx])
                for old_idx, _, _ in session.sorted_centroids
            ]
        elif body.displayIndex is not None and body.shrink is not None:
            idx = body.displayIndex
            if idx < 0 or idx >= len(session.leaf_shrinks):
                raise HTTPException(status_code=400, detail="Invalid displayIndex")
            session.leaf_shrinks[idx] = int(np.clip(body.shrink, 0, 50))
        return common.session_response(session)


@router.get("/api/session/leaf-preview")
def leaf_preview(
    displayIndex: int,
    shrink: int | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Full-resolution RGB crop for a leaf (optional shrink override for live UI)."""
    session = common.ensure_session_loaded(mgr)
    if session.sam_masks is None or not session.sorted_centroids:
        raise HTTPException(status_code=400, detail="No masks yet")
    if displayIndex < 0 or displayIndex >= len(session.sorted_centroids):
        raise HTTPException(status_code=400, detail="Invalid displayIndex")
    old_idx, _, _ = session.sorted_centroids[displayIndex]
    edited = session.edited_masks or session.sam_masks
    shrink_px = (
        int(np.clip(shrink, 0, 50))
        if shrink is not None
        else (
            session.leaf_shrinks[displayIndex]
            if displayIndex < len(session.leaf_shrinks)
            else 0
        )
    )
    preview = masks_mod.rgb_crop_preview(
        session.rgb_image,
        edited[old_idx],
        shrink_px=shrink_px,
        sam_mask=session.sam_masks[old_idx],
        brush_keep=(
            session.brush_keeps[old_idx]
            if session.brush_keeps is not None and old_idx < len(session.brush_keeps)
            else None
        ),
    )
    if preview is None:
        raise HTTPException(status_code=404, detail="Empty mask")
    return Response(content=common.encode_jpeg(preview, 92), media_type="image/jpeg")


@router.post("/api/session/masks")
def update_masks(
    body: MasksRequest,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Push client brush edits (PNG base64) into ``edited_masks`` by maskIndex."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        if session.sam_masks is None:
            raise HTTPException(status_code=400, detail="No SAM masks yet")
        if session.edited_masks is None:
            session.edited_masks = [m.copy() for m in session.sam_masks]
        if session.brush_keeps is None:
            session.brush_keeps = [np.zeros_like(m) for m in session.sam_masks]
        for item in body.masks:
            idx = item.maskIndex
            if idx < 0 or idx >= len(session.edited_masks):
                raise HTTPException(status_code=400, detail=f"Bad maskIndex {idx}")
            decoded = common.decode_mask_b64(item.maskPngBase64)
            if decoded.shape[:2] != session.rgb_image.shape[:2]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Mask size mismatch for index {idx}",
                )
            session.edited_masks[idx] = decoded
            if item.brushKeepPngBase64:
                keep = common.decode_mask_b64(item.brushKeepPngBase64)
                if keep.shape[:2] != session.rgb_image.shape[:2]:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Brush-keep size mismatch for index {idx}",
                    )
                session.brush_keeps[idx] = keep
        return common.session_response(session)


@router.post("/api/session/reset-mask")
def reset_mask(
    maskIndex: int,
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Discard brush edits for one leaf and restore the original SAM mask."""
    with mgr.locked() as session:
        common.assert_sample_key(session, sampleKey)
        if session.sam_masks is None:
            raise HTTPException(status_code=400, detail="No SAM masks")
        if maskIndex < 0 or maskIndex >= len(session.sam_masks):
            raise HTTPException(status_code=400, detail="Bad maskIndex")
        if session.edited_masks is None:
            session.edited_masks = [m.copy() for m in session.sam_masks]
        session.edited_masks[maskIndex] = session.sam_masks[maskIndex].copy()
        if session.brush_keeps is None:
            session.brush_keeps = [np.zeros_like(m) for m in session.sam_masks]
        else:
            session.brush_keeps[maskIndex] = np.zeros_like(session.sam_masks[maskIndex])
        return common.session_response(session)


def _ingest_optional_masks(session: Session, masks) -> None:
    """Apply optional mask payloads from Save without requiring a prior sync."""
    if not masks:
        return
    if session.edited_masks is None and session.sam_masks is not None:
        session.edited_masks = [m.copy() for m in session.sam_masks]
    if session.brush_keeps is None and session.sam_masks is not None:
        session.brush_keeps = [np.zeros_like(m) for m in session.sam_masks]
    if session.edited_masks is None or session.rgb_image is None:
        raise HTTPException(status_code=400, detail="No masks to update")
    for item in masks:
        idx = item.maskIndex
        if idx < 0 or idx >= len(session.edited_masks):
            raise HTTPException(status_code=400, detail=f"Bad maskIndex {idx}")
        decoded = common.decode_mask_b64(item.maskPngBase64)
        if decoded.shape[:2] != session.rgb_image.shape[:2]:
            raise HTTPException(
                status_code=400,
                detail=f"Mask size mismatch for index {idx}",
            )
        session.edited_masks[idx] = decoded
        if item.brushKeepPngBase64 and session.brush_keeps is not None:
            keep = common.decode_mask_b64(item.brushKeepPngBase64)
            if keep.shape[:2] != session.rgb_image.shape[:2]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Brush-keep size mismatch for index {idx}",
                )
            session.brush_keeps[idx] = keep


@router.post("/api/session/save")
def save_session(
    body: SaveRequest,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Crop each leaf, write ENVI/PNG, update progress.

    ``complete=True`` (default): mark Completed and return the next pending folder.
    ``complete=False``: mark Incomplete, return ``nextFolder: null`` (stay put).
    """
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        if session.sam_masks is None or not session.sorted_centroids:
            raise HTTPException(status_code=400, detail="Nothing to save")

        if body.mainLabel is not None:
            session.main_label = body.mainLabel.strip()
            if session.main_label:
                session.last_main_label = session.main_label
        if body.sublabels is not None:
            session.sublabels = [s.strip() for s in body.sublabels]
        if body.shrinks is not None:
            session.leaf_shrinks = [int(s) for s in body.shrinks]
        _ingest_optional_masks(session, body.masks)

        edited = session.edited_masks or session.sam_masks
        # Resolve export labels first so we can warn before clobbering disk files.
        planned: list[tuple[str, int, int]] = []
        for new_id, (old_idx, _cy, _cx) in enumerate(session.sorted_centroids):
            raw = (
                session.sublabels[new_id].strip()
                if new_id < len(session.sublabels)
                else ""
            )
            label_str = raw if raw else f"Leaf_{new_id + 1}"
            shrink = (
                session.leaf_shrinks[new_id] if new_id < len(session.leaf_shrinks) else 0
            )
            planned.append((label_str, old_idx, shrink))

        conflicts = [
            label
            for label, _idx, _sh in planned
            if save_mod.export_exists(session.vine_type, session.main_label, label)
        ]
        if conflicts and not body.forceOverwrite:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "would_overwrite",
                    "labels": conflicts,
                    "message": (
                        "Export folders already exist for: "
                        + ", ".join(conflicts)
                    ),
                },
            )

        saved_dirs = []
        for label_str, old_idx, shrink in planned:
            brush_keep = (
                session.brush_keeps[old_idx]
                if session.brush_keeps is not None and old_idx < len(session.brush_keeps)
                else None
            )
            cropped = masks_mod.crop_masked_leaf(
                session.hsi_cube,
                edited[old_idx],
                shrink_px=shrink,
                sam_mask=session.sam_masks[old_idx],
                brush_keep=brush_keep,
            )
            if cropped is not None:
                out = save_mod.save_leaf(
                    cropped, session.vine_type, session.main_label, label_str
                )
                saved_dirs.append(str(out))

        status = "Completed" if body.complete else "Incomplete"
        try:
            progress = save_mod.load_progress()
            progress[session.sample_key] = {
                "status": status,
                "main_label": session.main_label,
                "count": len(session.sorted_centroids),
            }
            save_mod.save_progress(progress)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        nxt = None
        if body.complete:
            folders = load_mod.list_sample_folders(Path(IMAGES[session.vine_type]))
            nxt = save_mod.next_pending_folder(
                folders, session.vine_type, session.folder, progress
            )
        return {
            "savedCount": len(saved_dirs),
            "savedDirs": saved_dirs,
            "nextFolder": nxt,
            "vineType": session.vine_type,
            "status": status,
        }


@router.post("/api/session/skip")
def skip_session(mgr: SessionManager = Depends(get_session_mgr)):
    """Mark sample Skipped in progress.json and return the next pending folder."""
    with mgr.locked() as session:
        if session.rgb_image is None or not session.sample_key:
            raise HTTPException(status_code=400, detail="No sample loaded")
        try:
            progress = save_mod.load_progress()
            progress[session.sample_key] = {"status": "Skipped"}
            save_mod.save_progress(progress)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        folders = load_mod.list_sample_folders(Path(IMAGES[session.vine_type]))
        nxt = save_mod.next_pending_folder(
            folders, session.vine_type, session.folder, progress
        )
        return {
            "nextFolder": nxt,
            "vineType": session.vine_type,
        }
