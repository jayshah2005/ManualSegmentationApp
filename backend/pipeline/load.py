"""Load sample PNG + ENVI reflectance cube and build an RGB preview for SAM/UI.

On disk each sample folder looks like::

    {folder}/{folder}.png              # camera RGB (sticky note / OCR)
    {folder}/results/REFLECTANCE_*.hdr # Specim IQ reflectance cube

The cube is rotated to match the PNG. ``hsi_to_rgb`` picks fixed band indices
(``RGB_BANDS`` in config) for the canvas — SAM never sees the full cube.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import spectral

from backend.config import RGB_BANDS


def list_sample_folders(base_path: Path) -> list[str]:
    """Folders that contain ``{name}/{name}.png`` (skips the shared ``results/`` dir)."""
    subfolders = [
        f.name
        for f in base_path.iterdir()
        if f.is_dir() and f.name != "results" and (f / f"{f.name}.png").exists()
    ]
    subfolders.sort()
    return subfolders


def sample_paths(vine_type: str, folder: str, images: dict[str, str]) -> tuple[Path, Path]:
    base = Path(images[vine_type])
    folder_path = base / folder
    png_path = folder_path / f"{folder}.png"
    hdr_path = folder_path / "results" / f"REFLECTANCE_{folder}.hdr"
    return png_path, hdr_path


def load_sample_data(png_path: Path, hdr_path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Load camera PNG (BGR) and HSI cube; rotate cube to match the PNG orientation."""
    png_img = cv2.imread(str(png_path))
    if png_img is None:
        raise FileNotFoundError(f"Could not read PNG: {png_path}")
    header = spectral.open_image(str(hdr_path))
    cube = header.load()
    cube = np.rot90(cube, k=3)
    return png_img, cube


def hsi_to_rgb(hsi_cube: np.ndarray) -> np.ndarray:
    """Peak-normalize Specim IQ RGB bands to uint8 for SAM2 and the canvas.

    Divides by the scene peak so bright sticky notes / badges stay readable
    (percentile “leaf boost” stretches crush those highlights to pure white).
    For dark foliage, use the UI **Brightness** control — display only.
    """
    rgb_image = hsi_cube[:, :, RGB_BANDS].astype(np.float32)
    peak = float(rgb_image.max()) if rgb_image.size else 0.0
    if peak > 0:
        return (rgb_image / peak * 255).astype(np.uint8)
    return np.zeros_like(rgb_image, dtype=np.uint8)
