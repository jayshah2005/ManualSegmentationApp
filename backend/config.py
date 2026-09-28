"""Dataset paths and Specim IQ / SAM2 constants.

Override any path with the matching environment variable when running elsewhere.
"""
import os
from pathlib import Path

SAM2_DIR = Path(os.environ.get("SAM2_DIR", "/home/jay/Desktop/CODE/sam2/"))
SAM2_CHECKPOINT = SAM2_DIR / "checkpoints" / "sam2.1_hiera_large.pt"
SAM2_CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"

# Vine type → root folder of indoor HSI captures.
IMAGES = {
    "Baco": os.environ.get(
        "HSI_BACO",
        "/home/jay/Desktop/VINO33/leaves_indoor/Aug12_2026_HSI_Baco_Row_18_17_16_15_14_leaves/",
    ),
    "Chardonnay": os.environ.get(
        "HSI_CHARDONNAY",
        "/home/jay/Desktop/VINO33/leaves_indoor/Aug262026_HSI_Chardonnay_leaves/",
    ),
    "Cab Franc": os.environ.get(
        "HSI_CAB_FRANC",
        "/home/jay/Desktop/VINO33/leaves_indoor/Sept03042026_HSI_CabFranc_leaves/",
    ),
    "Vidal": os.environ.get(
        "HSI_VIDAL",
        "/home/jay/Desktop/VINO33/leaves_indoor/Sept03042026_HSI_Vidal_leaves/",
    ),
}
OUTPUT_BASE_DIR = Path(os.environ.get("OUTPUT_BASE_DIR", "/home/jay/Desktop/CODE/Data"))
PROGRESS_FILE = OUTPUT_BASE_DIR / "progress.json"

# True-color band indices on Specim IQ cubes (R, G, B).
RGB_BANDS = [86, 53, 18]
# Auto NDVI peaks above this count are discarded (user places seeds instead).
MAX_AUTO_CENTROIDS = 5
# Click radius (image px) for toggling an existing seed on the canvas.
POINT_HIT_RADIUS = 22
