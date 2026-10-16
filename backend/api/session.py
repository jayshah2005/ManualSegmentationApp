"""Active image routes: open → add/edit objects (prompts) → brush → border → save/skip.

Objects are addressed by their stable ``id``. Prompt edits re-run SAM for that
object only, so other objects (and their brush edits) are never disturbed.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from backend.api import common
from backend.deps import get_models, get_sample_index, get_session_mgr, get_settings_store
from backend.models import ModelRegistry
from backend.pipeline import display as display_mod
from backend.pipeline import export as export_mod
from backend.pipeline import masks as masks_mod
from backend.pipeline import progress as progress_mod
from backend.pipeline.discover import SampleIndex
from backend.pipeline.loaders import LoadError, open_source
from backend.schemas import LoadRequest, MasksRequest, ObjectPatch, PromptsRequest, RotateRequest, SaveRequest
from backend.session import Session, SessionManager, rotate_session
from backend.settings import SettingsStore

router = APIRouter(tags=["session"])


def _require_dirs(settings) -> None:
    if not settings.inputDir or not settings.outputDir:
        raise HTTPException(status_code=400, detail="Choose an input and an output folder first")


@router.post("/api/session/load")
def load_session(
    body: LoadRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    store: SettingsStore = Depends(get_settings_store),
    index: SampleIndex = Depends(get_sample_index),
):
    """Open one image/cube: read it, build the display picture, start with no objects."""
    settings = store.get()
    _require_dirs(settings)
    sample = index.find(settings.inputDir, settings.recursive, settings.outputDir, body.sampleKey)
    if sample is None:
        raise HTTPException(status_code=404, detail=f"Image not found: {body.sampleKey}")
    try:
        source = open_source(sample.path)
        orientation = display_mod.effective_orientation(source.info(), settings.orientation)
        extra = progress_mod.get_rotation(progress_mod.load_progress(settings.outputDir), sample.key)
        rgb, bands = display_mod.build_display_rgb(source, settings.display, orientation, extra)
        info = source.info()
        native_hw = display_mod.oriented_size(info.width, info.height, orientation, extra)
    except (LoadError, OSError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with mgr.locked() as session:
        session.start(sample, source, rgb, bands, orientation, native_hw, extra)
        return common.session_response(session, settings)


@router.get("/api/session/rgb")
def get_rgb(sampleKey: str | None = None, mgr: SessionManager = Depends(get_session_mgr)):
    """JPEG of the display picture shown on the canvas."""
    session = common.ensure_session_loaded(mgr)
    common.assert_sample_key(session, sampleKey)
    return Response(content=common.encode_jpeg(session.rgb_image, 92), media_type="image/jpeg")


@router.get("/api/session")
def get_session(
    mgr: SessionManager = Depends(get_session_mgr),
    store: SettingsStore = Depends(get_settings_store),
):
    return common.session_response(common.ensure_session_loaded(mgr), store.get())


@router.post("/api/session/objects")
def add_object(
    body: PromptsRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
    store: SettingsStore = Depends(get_settings_store),
):
    """Create an object from points and/or a box, and segment it."""
    settings = store.get()
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        points, box = common.clamp_prompts(session, body.points, body.box)
        obj = session.new_object()
        obj.points, obj.box = points, box
        try:
            common.run_object(session, obj, models, settings)
        except Exception:
            session.objects.remove(obj)
            raise
        return {"object": common.object_payload(obj)}


@router.put("/api/session/objects/{object_id}/prompts")
def update_prompts(
    object_id: int,
    body: PromptsRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    models: ModelRegistry = Depends(get_models),
    store: SettingsStore = Depends(get_settings_store),
):
    """Replace one object's prompts and re-segment just that object."""
    settings = store.get()
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        obj = session.find(object_id)
        if obj is None:
            raise HTTPException(status_code=404, detail="Object not found")
        points, box = common.clamp_prompts(session, body.points, body.box)
        old = (obj.points, obj.box)
        obj.points, obj.box = points, box
        try:
            common.run_object(session, obj, models, settings)
        except Exception:
            obj.points, obj.box = old
            raise
        return {"object": common.object_payload(obj)}


@router.patch("/api/session/objects/{object_id}")
def patch_object(
    object_id: int,
    body: ObjectPatch,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Rename an object or change its border (px removed from the edge)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        obj = session.find(object_id)
        if obj is None:
            raise HTTPException(status_code=404, detail="Object not found")
        if body.label is not None:
            obj.label = body.label.strip()
        if body.shrink is not None:
            obj.shrink = int(body.shrink)
        return {"id": obj.id, "label": obj.label, "shrink": obj.shrink}


@router.delete("/api/session/objects/{object_id}")
def delete_object(
    object_id: int,
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    with mgr.locked() as session:
        common.assert_sample_key(session, sampleKey)
        obj = session.find(object_id)
        if obj is None:
            raise HTTPException(status_code=404, detail="Object not found")
        session.objects.remove(obj)
        return {"deletedId": object_id}


@router.post("/api/session/rotate")
def rotate_image(
    body: RotateRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    store: SettingsStore = Depends(get_settings_store),
):
    """Rotate just this image (objects, clicks and boxes turn with it); the choice is remembered."""
    settings = store.get()
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        rotate_session(session, body.degrees)
        if settings.outputDir:
            try:
                progress_mod.set_rotation(settings.outputDir, session.sample_key, session.extra_rotate)
            except RuntimeError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc
        return common.session_response(session, settings)


@router.post("/api/session/suggest-borders")
def suggest_borders(
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Heuristic border width for every object (based on size and edge roughness)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, sampleKey)
        for obj in session.objects:
            if obj.edited_mask is not None:
                obj.shrink = masks_mod.suggest_mask_shrink(obj.edited_mask)
        return {"shrinks": {str(o.id): o.shrink for o in session.objects}}


def _apply_masks(session: Session, items) -> None:
    for item in items or []:
        obj = session.find(item.objectId)
        if obj is None or obj.sam_mask is None:
            raise HTTPException(status_code=400, detail=f"Unknown object {item.objectId}")
        decoded = common.decode_mask_b64(item.maskPngBase64)
        if decoded.shape[:2] != session.rgb_image.shape[:2]:
            raise HTTPException(status_code=400, detail=f"Mask size mismatch for object {item.objectId}")
        obj.edited_mask = decoded
        if item.brushKeepPngBase64:
            keep = common.decode_mask_b64(item.brushKeepPngBase64)
            if keep.shape[:2] != decoded.shape[:2]:
                raise HTTPException(status_code=400, detail=f"Brush mask size mismatch for object {item.objectId}")
            obj.brush_keep = keep


@router.post("/api/session/masks")
def update_masks(
    body: MasksRequest,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Push client brush edits into the session (the client already has them: no echo)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        _apply_masks(session, body.masks)
        return {"ok": True, "count": len(body.masks)}


@router.post("/api/session/objects/{object_id}/reset-mask")
def reset_mask(
    object_id: int,
    sampleKey: str | None = None,
    mgr: SessionManager = Depends(get_session_mgr),
):
    """Discard brush edits for one object (back to the SAM result)."""
    with mgr.locked() as session:
        common.assert_sample_key(session, sampleKey)
        obj = session.find(object_id)
        if obj is None:
            raise HTTPException(status_code=404, detail="Object not found")
        obj.reset_edits()
        return {"object": common.object_payload(obj)}


@router.post("/api/session/save")
def save_session(
    body: SaveRequest,
    mgr: SessionManager = Depends(get_session_mgr),
    store: SettingsStore = Depends(get_settings_store),
    index: SampleIndex = Depends(get_sample_index),
):
    """Export every object, record progress, and optionally return the next image."""
    settings = store.get()
    _require_dirs(settings)
    with mgr.locked() as session:
        common.assert_sample_key(session, body.sampleKey)
        _apply_masks(session, body.masks)
        jobs = export_mod.plan_jobs(session.objects)
        if not jobs:
            raise HTTPException(status_code=400, detail="Nothing to save: add at least one object")

        info = session.info
        fmt = export_mod.resolve_format(settings.export, info.kind, info.format)
        out_dir = Path(settings.outputDir) / session.sample.output_rel
        conflicts = export_mod.find_conflicts(out_dir, jobs, fmt, settings.export)
        if conflicts and not body.forceOverwrite:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "would_overwrite",
                    "names": conflicts,
                    "message": "These files already exist: " + ", ".join(conflicts),
                },
            )
        try:
            records = export_mod.export_objects(
                source=session.source, display_rgb=session.rgb_image,
                orientation=session.orientation, native_hw=session.native_hw, extra_rotate=session.extra_rotate,
                cfg=settings.export,
                jobs=jobs, out_dir=out_dir, image_name=session.sample.name,
            )
            progress = progress_mod.load_progress(settings.outputDir)
            status = "Completed" if body.complete else "Incomplete"
            progress_mod.update_entry(progress, session.sample_key, status=status, count=len(records))
            progress_mod.save_progress(settings.outputDir, progress)
        except (OSError, RuntimeError, ValueError, LoadError) as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        nxt = None
        if body.complete:
            samples = index.scan(settings.inputDir, settings.recursive, settings.outputDir)
            nxt = progress_mod.next_sample_key(samples, session.sample_key, progress)
        return {
            "savedCount": len(records),
            "outputDir": str(out_dir),
            "files": [f for r in records for f in r["files"]],
            "nextSampleKey": nxt,
            "status": status,
        }


@router.post("/api/session/skip")
def skip_session(
    mgr: SessionManager = Depends(get_session_mgr),
    store: SettingsStore = Depends(get_settings_store),
    index: SampleIndex = Depends(get_sample_index),
):
    """Mark the image Skipped and return the next one to work on."""
    settings = store.get()
    _require_dirs(settings)
    with mgr.locked() as session:
        common.assert_sample_key(session, None)
        try:
            progress = progress_mod.load_progress(settings.outputDir)
            progress_mod.update_entry(progress, session.sample_key, status="Skipped")
            progress[session.sample_key].pop("count", None)
            progress_mod.save_progress(settings.outputDir, progress)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        samples = index.scan(settings.inputDir, settings.recursive, settings.outputDir)
        return {"nextSampleKey": progress_mod.next_sample_key(samples, session.sample_key, progress)}
