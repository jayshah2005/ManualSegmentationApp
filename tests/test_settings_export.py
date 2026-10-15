import cv2
import numpy as np

from backend.pipeline import export as ex
from backend.pipeline.loaders import open_source
from backend.session import ObjectState
from backend.settings import ExportSettings, OrientationSettings, Settings, SettingsStore


def test_settings_persist_and_merge(tmp_path):
    store = SettingsStore(tmp_path / "s.json")
    store.update({"export": {"saveMask": False}, "samModel": "tiny"})
    again = SettingsStore(tmp_path / "s.json").get()
    assert again.samModel == "tiny" and again.export.saveMask is False
    assert again.export.cropToBBox is True  # untouched siblings survive a nested patch
    (tmp_path / "s.json").write_text("{not json")
    assert SettingsStore(tmp_path / "s.json").get() == Settings()


def _obj(oid, label, mask):
    o = ObjectState(id=oid, label=label, sam_mask=mask)
    o.reset_edits()
    return o


def test_export_rgb_alpha_png_and_metadata(tmp_path):
    img = np.full((20, 30, 3), 200, np.uint8)
    src_path = tmp_path / "p.png"
    cv2.imwrite(str(src_path), img)
    mask = np.zeros((20, 30), np.uint8)
    mask[5:10, 8:20] = 255
    jobs = ex.plan_jobs([_obj(1, "leaf a/b", mask), _obj(2, "", mask), _obj(3, "", np.zeros_like(mask))])
    assert [j.name for j in jobs] == ["leaf a_b", "object_002"]  # unsafe chars cleaned; empty skipped
    cfg = ExportSettings(metadata="coco")
    out = tmp_path / "out" / "p"
    src = open_source(src_path)
    recs = ex.export_objects(source=src, display_rgb=img[:, :, ::-1].copy(), orientation=OrientationSettings(),
                             cfg=cfg, jobs=jobs, out_dir=out, image_name="p.png")
    png = cv2.imread(str(out / "leaf a_b.png"), cv2.IMREAD_UNCHANGED)
    assert png.shape == (5, 12, 4) and (png[:, :, 3] == 255).all()  # cropped, opaque inside
    assert (out / "leaf a_b_mask.png").exists() and (out / "annotations.coco.json").exists()
    assert recs[0]["bbox"] == [8, 5, 20, 10]
    assert ex.find_conflicts(out, jobs, "png", cfg) == ["leaf a_b", "object_002"]


def test_export_cube_same_format_zero_outside(tmp_path):
    from spectral.io import envi

    cube = np.ones((10, 10, 4), np.float32)
    envi.save_image(str(tmp_path / "c.hdr"), cube, force=True, ext="img")
    src = open_source(tmp_path / "c.hdr")
    mask = np.zeros((10, 10), np.uint8)
    mask[2:6, 3:7] = 255
    mask[2, 3] = 0
    jobs = ex.plan_jobs([_obj(1, "x", mask)])
    out = tmp_path / "o"
    ex.export_objects(source=src, display_rgb=np.zeros((10, 10, 3), np.uint8), orientation=OrientationSettings(),
                      cfg=ExportSettings(), jobs=jobs, out_dir=out, image_name="c.hdr")  # preview is on by default
    saved = open_source(out / "x.hdr").read_cube()
    assert saved.shape == (4, 4, 4) and saved[0, 0].sum() == 0 and saved[1, 1].sum() == 4
    assert (out / "x_preview.png").exists()
    assert ex.resolve_format(ExportSettings(), "cube", "mat") == "npy"


def test_preview_can_be_disabled_and_is_skipped_for_png(tmp_path):
    from spectral.io import envi

    envi.save_image(str(tmp_path / "c.hdr"), np.ones((6, 6, 3), np.float32), force=True, ext="img")
    mask = np.zeros((6, 6), np.uint8)
    mask[1:4, 1:4] = 255
    jobs = ex.plan_jobs([_obj(1, "x", mask)])
    out = tmp_path / "o"
    ex.export_objects(source=open_source(tmp_path / "c.hdr"), display_rgb=np.zeros((6, 6, 3), np.uint8),
                      orientation=OrientationSettings(), cfg=ExportSettings(savePreview=False),
                      jobs=jobs, out_dir=out, image_name="c.hdr")
    assert not (out / "x_preview.png").exists()
    assert ex.output_files(out, "x", "png", ExportSettings()) == [out / "x.png", out / "x_mask.png"]
