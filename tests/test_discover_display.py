import cv2
import numpy as np
from spectral.io import envi

from backend.pipeline.discover import discover
from backend.pipeline.display import apply_orientation, auto_bands, build_display_rgb
from backend.pipeline.loaders import open_source
from backend.settings import DisplaySettings, OrientationSettings


def _png(path, shape=(8, 8, 3)):
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), np.zeros(shape, np.uint8))


def _envi(hdr):
    hdr.parent.mkdir(parents=True, exist_ok=True)
    envi.save_image(str(hdr), np.zeros((4, 4, 3), np.float32), force=True, ext="img")


def test_discovery_nested_dedupe_and_specim(tmp_path):
    root = tmp_path / "in"
    _png(root / "a.png")
    _png(root / "sub" / "deep" / "b.jpg".replace("jpg", "png"))
    _envi(root / "cube1.hdr")  # .hdr + .img = ONE sample
    # Specim IQ folder: preview png, capture, results -> ONE sample
    _png(root / "cap1" / "cap1.png")
    _envi(root / "cap1" / "results" / "REFLECTANCE_cap1.hdr")
    _envi(root / "cap1" / "capture" / "cap1.hdr")
    _png(root / ".hidden" / "x.png")
    _png(root / "out" / "result.png")  # nested output dir is excluded
    (root / "notes.txt").write_text("x")

    keys = [s.key for s in discover(root, True, exclude=[root / "out"])]
    assert keys == ["a.png", "cap1", "cube1.hdr", "sub/deep/b.png"]
    flat = [s.key for s in discover(root, False, exclude=[root / "out"])]
    assert flat == ["a.png", "cap1", "cube1.hdr"] or flat == ["a.png", "cube1.hdr"]
    specim = next(s for s in discover(root) if s.key == "cap1")
    assert specim.is_folder and specim.path.name == "REFLECTANCE_cap1.hdr"
    assert specim.output_rel == "cap1"


def test_orphan_hdr_ignored(tmp_path):
    (tmp_path / "lonely.hdr").write_text("ENVI\n")
    assert discover(tmp_path) == []


def test_auto_bands_and_orientation():
    wl = list(np.linspace(400, 1000, 204))
    r, g, b = auto_bands(204, wl)
    assert abs(wl[r] - 640) < 5 and abs(wl[g] - 550) < 5 and abs(wl[b] - 460) < 5
    assert auto_bands(3, None) == [0, 1, 2] and len(auto_bands(10, None)) == 3
    a = np.arange(6).reshape(2, 3)
    assert apply_orientation(a, OrientationSettings(rotate=90)).shape == (3, 2)
    assert apply_orientation(a, OrientationSettings(flipH=True))[0, 0] == 2


def test_display_rgb_for_cube(tmp_path):
    cube = np.random.rand(6, 7, 10).astype(np.float32)
    envi.save_image(str(tmp_path / "c.hdr"), cube, force=True, ext="img")
    rgb, used = build_display_rgb(open_source(tmp_path / "c.hdr"), DisplaySettings(), OrientationSettings(rotate=90))
    assert rgb.dtype == np.uint8 and rgb.shape == (7, 6, 3) and len(used) == 3
