import cv2
import h5py
import numpy as np
import pytest
import tifffile
from scipy.io import savemat
from spectral.io import envi

from backend.pipeline.loaders import LoadError, open_source


def test_rgb_png_and_unicode_path(tmp_path):
    img = np.random.randint(0, 255, (20, 30, 3), np.uint8)
    p = tmp_path / "ünï.png"
    cv2.imencode(".png", img)[1].tofile(str(p))
    src = open_source(p)
    info = src.info()
    assert (info.kind, info.width, info.height, info.bands) == ("rgb", 30, 20, 3)
    assert np.array_equal(src.read_cube(), img[:, :, ::-1])  # BGR on disk -> RGB out


def test_tiff_rgb_vs_multiband(tmp_path):
    tifffile.imwrite(tmp_path / "rgb.tif", np.zeros((10, 12, 3), np.uint8), photometric="rgb")
    assert open_source(tmp_path / "rgb.tif").info().kind == "rgb"
    multi = np.random.rand(10, 12, 7).astype(np.float32)
    tifffile.imwrite(tmp_path / "ms.tif", multi, photometric="minisblack", planarconfig="contig")
    info = open_source(tmp_path / "ms.tif").info()
    assert (info.kind, info.bands, info.width, info.height) == ("cube", 7, 12, 10)
    # channels-first stack of pages
    tifffile.imwrite(tmp_path / "pages.tif", np.moveaxis(multi, -1, 0))
    assert open_source(tmp_path / "pages.tif").read_cube().shape == (10, 12, 7)


def test_envi_with_wavelengths_and_partial_read(tmp_path):
    cube = np.random.rand(8, 9, 6).astype(np.float32)
    wl = [450.0, 500.0, 550.0, 600.0, 650.0, 700.0]
    envi.save_image(str(tmp_path / "c.hdr"), cube, force=True, ext="img",
                    metadata={"wavelength": [str(w) for w in wl]})
    src = open_source(tmp_path / "c.hdr")
    info = src.info()
    assert info.kind == "cube" and info.bands == 6 and info.wavelengths == wl
    assert np.allclose(src.read_bands([4, 2, 0]), cube[:, :, [4, 2, 0]])


def test_npy_npz_channels_first(tmp_path):
    hwb = np.random.rand(40, 50, 5).astype(np.float32)
    np.save(tmp_path / "a.npy", hwb)
    assert open_source(tmp_path / "a.npy").read_cube().shape == (40, 50, 5)
    np.save(tmp_path / "b.npy", np.moveaxis(hwb, -1, 0))  # (5, 40, 50)
    assert open_source(tmp_path / "b.npy").read_cube().shape == (40, 50, 5)
    np.savez(tmp_path / "c.npz", small=np.zeros((2, 2)), big=hwb)
    assert open_source(tmp_path / "c.npz").info().bands == 5


def test_mat_v5_and_v73(tmp_path):
    cube = np.random.rand(11, 13, 4)
    savemat(tmp_path / "v5.mat", {"cube": cube, "meta": 3})
    assert np.allclose(open_source(tmp_path / "v5.mat").read_cube(), cube)
    with h5py.File(tmp_path / "v73.mat", "w") as f:
        f.create_dataset("cube", data=cube.T)  # MATLAB v7.3 reverses axes
    assert np.allclose(open_source(tmp_path / "v73.mat").read_cube(), cube)


def test_bad_files(tmp_path):
    (tmp_path / "bad.png").write_bytes(b"nope")
    with pytest.raises(LoadError):
        open_source(tmp_path / "bad.png").read_cube()
    with pytest.raises(LoadError):
        open_source(tmp_path / "x.xyz")


def test_jpeg_exif_orientation_is_applied_but_png_data_is_untouched(tmp_path):
    from PIL import Image

    img = np.zeros((40, 60, 3), np.uint8)
    img[:20, :30] = (255, 0, 0)  # red top-left marker
    exif = Image.Exif()
    exif[274] = 3  # stored upside down: viewers rotate 180 degrees
    Image.fromarray(img).save(tmp_path / "phone.jpg", exif=exif, quality=100, subsampling=0)
    up = open_source(tmp_path / "phone.jpg").read_cube()
    assert up.shape == (40, 60, 3)
    assert up[-5, -5, 0] > 200 and up[5, 5, 0] < 60  # marker moved to bottom-right
    cv2.imwrite(str(tmp_path / "p16.png"), (np.arange(20 * 20, dtype=np.uint16).reshape(20, 20, 1).repeat(3, 2)) * 100)
    assert open_source(tmp_path / "p16.png").read_cube().dtype == np.uint16  # 16-bit survives
