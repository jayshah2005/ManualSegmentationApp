"""Write segmented objects to disk.

Layout (mirrors the input tree)::

    {output}/{relative/path/of/image}/object_001.png        # cut-out
    {output}/{relative/path/of/image}/object_001_mask.png   # optional
    {output}/{relative/path/of/image}/objects.csv           # optional metadata

The cut-out format follows the input by default: photos become RGBA PNGs with a
transparent background; spectral cubes keep their format (ENVI/TIFF/NPY) with
pixels outside the mask set to zero. Everything is user-configurable.
"""
from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import tifffile
from spectral.io import envi

from backend.pipeline import masks as masks_mod
from backend.pipeline.display import apply_orientation
from backend.pipeline.loaders import ImageSource
from backend.session import ObjectState
from backend.settings import ExportSettings, OrientationSettings

_BAD_CHARS = re.compile(r"[^\w\-. ]+", re.UNICODE)


@dataclass
class ExportJob:
    name: str  # file stem
    obj: ObjectState
    mask: np.ndarray  # final 0/255 mask in oriented coordinates


def safe_stem(label: str, obj_id: int) -> str:
    cleaned = _BAD_CHARS.sub("_", label.strip()).strip(" .")
    return cleaned or f"object_{obj_id:03d}"


def plan_jobs(objects: list[ObjectState]) -> list[ExportJob]:
    """Final masks + unique file stems. Objects with an empty mask are skipped."""
    jobs: list[ExportJob] = []
    used: dict[str, int] = {}
    for obj in objects:
        if obj.edited_mask is None:
            continue
        mask = masks_mod.apply_shrink_preserving_edits(
            obj.edited_mask, sam_mask=obj.sam_mask, shrink_px=obj.shrink, brush_keep=obj.brush_keep
        )
        if masks_mod.mask_bbox(mask) is None:
            continue
        stem = safe_stem(obj.label, obj.id)
        used[stem] = used.get(stem, 0) + 1
        if used[stem] > 1:
            stem = f"{stem}_{used[stem]}"
        jobs.append(ExportJob(stem, obj, mask))
    return jobs


def resolve_format(cfg: ExportSettings, kind: str, src_format: str) -> str:
    if cfg.format != "same_as_input":
        return cfg.format
    if kind == "rgb":
        return "png"
    return {"envi": "envi", "tiff": "tiff"}.get(src_format, "npy")


_EXT = {"png": ".png", "tiff": ".tif", "npy": ".npy", "envi": ".img"}


def output_files(out_dir: Path, stem: str, fmt: str, cfg: ExportSettings) -> list[Path]:
    files = [out_dir / f"{stem}{_EXT[fmt]}"]
    if fmt == "envi":
        files.append(out_dir / f"{stem}.hdr")
    if cfg.saveMask:
        files.append(out_dir / f"{stem}_mask.png")
    if cfg.savePreview and fmt != "png":
        files.append(out_dir / f"{stem}_preview.png")
    return files


def find_conflicts(out_dir: Path, jobs: list[ExportJob], fmt: str, cfg: ExportSettings) -> list[str]:
    return [
        j.name for j in jobs if any(p.exists() for p in output_files(out_dir, j.name, fmt, cfg))
    ]


def _crop(arr: np.ndarray, mask: np.ndarray, crop: bool):
    if not crop:
        return arr, mask, (0, 0)
    ymin, ymax, xmin, xmax = masks_mod.mask_bbox(mask)  # type: ignore[misc]
    return arr[ymin : ymax + 1, xmin : xmax + 1], mask[ymin : ymax + 1, xmin : xmax + 1], (xmin, ymin)


def _write_png_rgba(path: Path, rgb: np.ndarray, mask: np.ndarray) -> None:
    bgr = rgb[:, :, ::-1]
    alpha_val = 65535 if rgb.dtype == np.uint16 else 255
    alpha = np.where(mask > 0, alpha_val, 0).astype(rgb.dtype)
    out = np.dstack([bgr, alpha])
    ok, buf = cv2.imencode(".png", out)
    if not ok:
        raise OSError(f"PNG encode failed for {path.name}")
    path.write_bytes(buf.tobytes())


def _write_cube(path: Path, fmt: str, cube: np.ndarray, wavelengths: list[float] | None) -> None:
    if fmt == "npy":
        np.save(path, cube)
    elif fmt == "tiff":
        tifffile.imwrite(
            str(path),
            cube,
            photometric="rgb" if cube.shape[2] == 3 else "minisblack",
            planarconfig="contig",
        )
    elif fmt == "envi":
        meta = {"wavelength": [f"{w:g}" for w in wavelengths]} if wavelengths else {}
        envi.save_image(
            str(path.with_suffix(".hdr")), cube, dtype=cube.dtype, force=True,
            ext=".img", interleave="bil", metadata=meta,
        )


def _polygons(mask: np.ndarray) -> list[list[float]]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for c in contours:
        if len(c) >= 3:
            polys.append([float(v) for v in c.reshape(-1)])
    return polys


def export_objects(
    *,
    source: ImageSource,
    display_rgb: np.ndarray,
    orientation: OrientationSettings,
    cfg: ExportSettings,
    jobs: list[ExportJob],
    out_dir: Path,
    image_name: str,
) -> list[dict]:
    """Write every job; returns one record per exported object."""
    info = source.info()
    fmt = resolve_format(cfg, info.kind, info.format)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Native-resolution data is only needed for the cut-out itself.
    native: np.ndarray | None = None
    if fmt != "png" or info.kind == "rgb":
        native = apply_orientation(source.read_cube(), orientation)
    use_display_for_png = fmt == "png" and (
        info.kind != "rgb" or native is None or native.dtype not in (np.uint8, np.uint16)
    )

    records: list[dict] = []
    for job in jobs:
        mask = job.mask
        files: list[str] = []

        if fmt == "png":
            base = display_rgb if use_display_for_png else native
            if base.shape[2] == 1:  # grayscale source
                base = np.repeat(base, 3, axis=2)
            data, m, (x0, y0) = _crop(base[:, :, :3], mask, cfg.cropToBBox)
            _write_png_rgba(out_dir / f"{job.name}.png", data, m)
            files.append(f"{job.name}.png")
        else:
            assert native is not None
            data, m, (x0, y0) = _crop(native, mask, cfg.cropToBBox)
            data = np.where(m[:, :, None] > 0, data, 0).astype(native.dtype)
            _write_cube(out_dir / f"{job.name}{_EXT[fmt]}", fmt, data, info.wavelengths)
            files.append(f"{job.name}{_EXT[fmt]}")
            if fmt == "envi":
                files.append(f"{job.name}.hdr")
            if cfg.savePreview:
                prev, pm, _ = _crop(display_rgb, mask, cfg.cropToBBox)
                _write_png_rgba(out_dir / f"{job.name}_preview.png", prev, pm)
                files.append(f"{job.name}_preview.png")

        if cfg.saveMask:
            ok, buf = cv2.imencode(".png", (m > 0).astype(np.uint8) * 255)
            if not ok:
                raise OSError(f"PNG encode failed for {job.name}_mask.png")
            (out_dir / f"{job.name}_mask.png").write_bytes(buf.tobytes())
            files.append(f"{job.name}_mask.png")

        ys, xs = np.where(mask > 0)
        records.append(
            {
                "id": job.obj.id,
                "name": job.name,
                "label": job.obj.label,
                "files": files,
                "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                "cropOrigin": [int(x0), int(y0)],
                "areaPx": int((mask > 0).sum()),
                "centroid": [float(xs.mean()), float(ys.mean())],
                "shrink": job.obj.shrink,
                "points": [list(p) for p in job.obj.points],
                "box": list(job.obj.box) if job.obj.box else None,
                "_polygons": _polygons(mask),
            }
        )

    _write_metadata(out_dir, cfg, records, image_name, display_rgb.shape[1], display_rgb.shape[0])
    for r in records:
        r.pop("_polygons", None)
    return records


def _write_metadata(out_dir: Path, cfg: ExportSettings, records: list[dict], image_name: str, w: int, h: int) -> None:
    if cfg.metadata == "csv":
        with open(out_dir / "objects.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["id", "name", "label", "file", "x0", "y0", "x1", "y1", "area_px", "centroid_x", "centroid_y", "border_px"])
            for r in records:
                writer.writerow([
                    r["id"], r["name"], r["label"], r["files"][0], *r["bbox"],
                    r["areaPx"], f"{r['centroid'][0]:.1f}", f"{r['centroid'][1]:.1f}", r["shrink"],
                ])
    elif cfg.metadata == "coco":
        anns = []
        for i, r in enumerate(records, start=1):
            x0, y0, x1, y1 = r["bbox"]
            anns.append({
                "id": i, "image_id": 1, "category_id": 1,
                "segmentation": r["_polygons"], "area": r["areaPx"],
                "bbox": [x0, y0, x1 - x0, y1 - y0], "iscrowd": 0,
                "attributes": {"label": r["label"], "name": r["name"]},
            })
        doc = {
            "images": [{"id": 1, "file_name": image_name, "width": w, "height": h}],
            "categories": [{"id": 1, "name": "object"}],
            "annotations": anns,
        }
        (out_dir / "annotations.coco.json").write_text(json.dumps(doc, indent=2), "utf-8")
