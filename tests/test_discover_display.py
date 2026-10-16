import cv2
import numpy as np
from spectral.io import envi

from backend.pipeline.discover import discover
from backend.pipeline.display import rotate_array, rotate_box, rotate_point, apply_orientation, auto_bands, build_display_rgb, effective_orientation, limit_size, oriented_size
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
    assert flat == ["a.png", "cap1", "cube1.hdr"]  # capture folders count even when not recursive
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


def test_same_stem_files_get_distinct_output_folders(tmp_path):
    _png(tmp_path / "x.png")
    _envi(tmp_path / "x.hdr")
    _png(tmp_path / "solo.png")
    rels = {s.key: s.output_rel for s in discover(tmp_path)}
    assert rels == {"x.png": "x_png", "x.hdr": "x_hdr", "solo.png": "solo"}


def test_symlinked_folders_followed_without_looping(tmp_path):
    real = tmp_path / "real"
    _png(real / "a.png")
    root = tmp_path / "root"
    root.mkdir()
    (root / "linked").symlink_to(real, target_is_directory=True)
    (root / "loop").symlink_to(root, target_is_directory=True)
    assert [s.key for s in discover(root)] == ["linked/a.png"]


def test_specim_iq_is_turned_upright_automatically(tmp_path):
    cube = np.random.rand(6, 4, 3).astype(np.float32)
    envi.save_image(str(tmp_path / "s.hdr"), cube, force=True, ext="img", metadata={"sensor type": "SPECIM IQ"})
    envi.save_image(str(tmp_path / "o.hdr"), cube, force=True, ext="img")
    specim, other = open_source(tmp_path / "s.hdr").info(), open_source(tmp_path / "o.hdr").info()
    assert specim.sensor == "SPECIM IQ" and other.sensor is None
    assert effective_orientation(specim, OrientationSettings()).rotate == 90
    assert effective_orientation(specim, OrientationSettings(rotate=90)).rotate == 180
    assert effective_orientation(specim, OrientationSettings(autoUpright=False)).rotate == 0
    assert effective_orientation(other, OrientationSettings()).rotate == 0


def test_working_resolution_cap():
    big = np.zeros((300, 600, 3), np.uint8)
    assert limit_size(big, 0).shape == big.shape  # 0 = full size
    assert limit_size(big, 1000).shape == big.shape  # already small enough
    assert limit_size(big, 300).shape == (150, 300, 3)
    assert oriented_size(600, 300, OrientationSettings(rotate=90)) == (600, 300)
    assert oriented_size(600, 300, OrientationSettings()) == (300, 600)


def test_rotation_helpers_agree_with_each_other():
    h, w = 4, 7
    img = np.arange(h * w).reshape(h, w)
    for deg in (90, 180, 270):
        rot = rotate_array(img, deg)
        for (x, y) in [(0, 0), (6, 0), (2, 3), (6, 3)]:
            nx, ny = rotate_point(x, y, w, h, deg)
            assert rot[ny, nx] == img[y, x], (deg, x, y)
        # box in edge coordinates covers exactly the rotated pixels
        x0, y0, x1, y1 = rotate_box((1, 0, 4, 2), w, h, deg)
        covered = np.zeros_like(rot, bool)
        covered[y0:y1, x0:x1] = True
        src = np.zeros((h, w), bool)
        src[0:2, 1:4] = True
        assert (rotate_array(src, deg) == covered).all(), deg
    assert rotate_array(img, 360).shape == img.shape


def test_extra_rotation_stacks_on_the_global_orientation():
    a = np.arange(6).reshape(2, 3)
    base = OrientationSettings(rotate=90)
    assert (apply_orientation(a, base, 90) == apply_orientation(a, OrientationSettings(rotate=180))).all()
    assert apply_orientation(a, OrientationSettings(), 90).shape == (3, 2)
    assert oriented_size(3, 2, OrientationSettings(rotate=90), 90) == (2, 3)
