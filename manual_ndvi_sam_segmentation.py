"""
LEGACY Streamlit UI — prefer the FastAPI + React app instead.

Run the new app (see README.md):
  ./run_dev.sh
  # or: ./scripts/run_backend.py  and  ./scripts/run_frontend.sh

This file is kept for reference / parity with the original pipeline.
"""
import json
import re
import sys
import cv2
import easyocr
import numpy as np
import spectral
from spectral.io import envi
import torch
from pathlib import Path
from PIL import Image
from skimage.feature import peak_local_max
from streamlit_drawable_canvas import st_canvas
import streamlit as st
from urllib.parse import quote

# ==========================================
# Paths & System Initialization
# ==========================================
SAM2_DIR = Path("/home/jay/Desktop/CODE/sam2/")
sys.path.append(str(SAM2_DIR))

from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

IMAGES = {
    "Baco": "/home/jay/Desktop/VINO33/leaves_indoor/Aug12_2026_HSI_Baco_Row_18_17_16_15_14_leaves/",
    "Chardonnay": "/home/jay/Desktop/VINO33/leaves_indoor/Aug262026_HSI_Chardonnay_leaves/",
    "Cab Franc": "/home/jay/Desktop/VINO33/leaves_indoor/Sept03042026_HSI_CabFranc_leaves/",
    "Vidal": "/home/jay/Desktop/VINO33/leaves_indoor/Sept03042026_HSI_Vidal_leaves/",
}
OUTPUT_BASE_DIR = Path("/home/jay/Desktop/CODE/Data")
PROGRESS_FILE = OUTPUT_BASE_DIR / "progress.json"

# Defined True RGB Band Indices for Specim IQ
RGB_BANDS = [86, 53, 18]
MAX_AUTO_CENTROIDS = 4  # keep auto seeds only when count is < 5

st.set_page_config(layout="wide", page_title="HSI Leaf Curation Pipeline")


# ==========================================
# Model & Progress Caching
# ==========================================
@st.cache_resource
def load_sam2():
    SAM2_CHECKPOINT = f"{SAM2_DIR}/checkpoints/sam2.1_hiera_large.pt"
    SAM2_CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"
    device = "cuda" if torch.cuda.is_available() else "cpu"
    sam2_model = build_sam2(SAM2_CONFIG, SAM2_CHECKPOINT, device=device)
    return SAM2ImagePredictor(sam2_model)


@st.cache_resource
def load_ocr():
    return easyocr.Reader(["en"], gpu=True)


def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_progress(progress):
    OUTPUT_BASE_DIR.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=4)


# ==========================================
# Core Processing Utilities
# ==========================================
def extract_labels(img, reader):
    def detect_sticky_note(img):
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        lower = np.array([30, 70, 70])
        upper = np.array([60, 255, 255])
        mask = cv2.inRange(hsv, lower, upper)
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            return None
        image_area = img.shape[0] * img.shape[1]
        candidates = [c for c in contours if 0.001 * image_area < cv2.contourArea(c)]
        if not candidates:
            return None
        contour = max(candidates, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(contour)
        return (x, y, x + w, y + h)

    h_orig, w_orig, _ = img.shape
    bbox = detect_sticky_note(img)
    if bbox is None:
        return [], []

    xmin, ymin, xmax, ymax = bbox
    padding = 10
    xmin, ymin = max(0, xmin - padding), max(0, ymin - padding)
    xmax, ymax = min(w_orig, xmax + padding), min(h_orig, ymax + padding)

    cropped_note = img[ymin:ymax, xmin:xmax]
    gray = cv2.cvtColor(cropped_note, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (0, 0), fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    processed_img = cv2.adaptiveThreshold(
        resized, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 4
    )

    allowed_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    results = reader.readtext(processed_img, allowlist=allowed_chars)

    label_pattern = re.compile(r"^[A-Za-z]{2}\d+$")
    number_pattern = re.compile(r"^\d+$")
    valid_entries = []

    for _, text, prob in results:
        clean_text = text.strip()
        if len(clean_text) <= 2 and not clean_text.isdigit():
            clean_text = (
                clean_text.replace("s", "5")
                .replace("S", "5")
                .replace("o", "0")
                .replace("O", "0")
                .replace("g", "9")
                .replace("q", "9")
                .replace("l", "1")
                .replace("i", "1")
                .replace("I", "1")
            )
        if len(clean_text) >= 3 and clean_text[:2].isalpha():
            remainder = (
                clean_text[2:]
                .replace("y", "4")
                .replace("h", "4")
                .replace("u", "4")
                .replace("t", "4")
                .replace("o", "0")
                .replace("O", "0")
                .replace("s", "5")
                .replace("S", "5")
            )
            clean_text = clean_text[:2] + remainder

        if label_pattern.match(clean_text):
            valid_entries.append(clean_text[:2].upper() + clean_text[2:])
        elif number_pattern.match(clean_text):
            valid_entries.append(clean_text)

    main_labels = valid_entries[:1]
    sublabels = valid_entries[1:]
    sublabels.sort()
    return main_labels, sublabels


def clean_mask(mask):
    """Fills internal holes and removes floating noise artifacts from SAM 2 output."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return mask

    largest_contour = max(contours, key=cv2.contourArea)
    cleaned = np.zeros_like(mask)
    cv2.drawContours(cleaned, [largest_contour], -1, 255, thickness=cv2.FILLED)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)
    return cleaned


def get_sam2_seed_prompts(hsi_cube, ndvi_thresh=0.4, min_dist=30):
    nir_band = hsi_cube[:, :, 180]
    red_band = hsi_cube[:, :, 100]
    numerator = nir_band.astype(np.float32) - red_band.astype(np.float32)
    denominator = nir_band.astype(np.float32) + red_band.astype(np.float32) + 1e-6
    ndvi = numerator / denominator

    binary = (ndvi > ndvi_thresh).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    coords = peak_local_max(dist_transform, min_distance=min_dist, labels=binary)
    seeds = [(int(c[1]), int(c[0])) for c in coords]
    # Too many auto peaks → unreliable; let the user place seeds manually
    if len(seeds) > MAX_AUTO_CENTROIDS:
        return []
    return seeds


def run_sam2_inference(sam2_predictor, rgb_image, seed_points):
    """Runs SAM 2 inference on natural RGB image and applies morphological mask cleanup."""
    if not seed_points:
        return [], []

    sam2_predictor.set_image(rgb_image)
    masks = []
    centroids = []

    for cx, cy in seed_points:
        mask, _, _ = sam2_predictor.predict(
            point_coords=np.array([[cx, cy]]),
            point_labels=np.array([1]),
            multimask_output=False,
        )
        binary_mask = (mask[0] > 0).astype(np.uint8) * 255
        cleaned_binary_mask = clean_mask(binary_mask)
        masks.append(cleaned_binary_mask)

        y_indices, x_indices = np.where(cleaned_binary_mask == 255)
        if len(y_indices) > 0:
            centroids.append(
                (len(masks) - 1, float(np.mean(y_indices)), float(np.mean(x_indices)))
            )

    return masks, centroids


def disk_kernel(radius):
    """Binary disk SE matching the UI border test (dx*dx + dy*dy <= r*r)."""
    r = max(0, int(radius))
    if r <= 0:
        return np.ones((1, 1), dtype=np.uint8)
    y, x = np.ogrid[-r : r + 1, -r : r + 1]
    return ((x * x + y * y) <= r * r).astype(np.uint8)


def erode_mask(mask, shrink_px=0):
    """Remove a border of shrink_px pixels (same disk as the React UI)."""
    r = max(0, int(shrink_px))
    if r <= 0:
        return mask.copy()
    return cv2.erode(
        mask,
        disk_kernel(r),
        iterations=1,
        borderType=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def apply_shrink_preserving_edits(edited_mask, sam_mask=None, shrink_px=0, brush_keep=None):
    """
    Border erodes the original SAM mask; brush additions / brush_keep stay;
    erasures stay gone. Changing border never re-fringes brush paint.
    """
    edited = ((edited_mask > 0).astype(np.uint8)) * 255
    if sam_mask is None:
        return erode_mask(edited, shrink_px)

    sam = ((sam_mask > 0).astype(np.uint8)) * 255
    additions = ((edited == 255) & (sam == 0)).astype(np.uint8) * 255
    erasures = (sam == 255) & (edited == 0)

    working = erode_mask(sam, shrink_px)
    if np.any(additions):
        working = np.maximum(working, additions)
    if brush_keep is not None:
        keep = ((brush_keep > 0) & (edited == 255)).astype(np.uint8) * 255
        if np.any(keep):
            working = np.maximum(working, keep)
    working[erasures] = 0
    return working


def mask_bbox(mask):
    """Return (ymin, ymax, xmin, xmax) of a binary mask, or None if empty."""
    y_indices, x_indices = np.where(mask == 255)
    if len(y_indices) == 0:
        return None
    return (
        int(y_indices.min()),
        int(y_indices.max()),
        int(x_indices.min()),
        int(x_indices.max()),
    )


def suggest_mask_shrink(mask, min_px=2, max_px=30):
    """Estimate a sensible border-removal width from mask size and edge irregularity."""
    bbox = mask_bbox(mask)
    if bbox is None:
        return min_px
    ymin, ymax, xmin, xmax = bbox
    h, w = ymax - ymin + 1, xmax - xmin + 1
    min_side = max(1, min(h, w))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return min_px
    cnt = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(cnt))
    peri = float(cv2.arcLength(cnt, True))
    if area <= 0 or peri <= 0:
        return min_px

    # Lower circularity / solidity → jagged SAM edge → remove a wider border
    circularity = float(np.clip(4.0 * np.pi * area / (peri * peri), 0.0, 1.0))
    hull = cv2.convexHull(cnt)
    hull_area = float(cv2.contourArea(hull)) or area
    solidity = float(np.clip(area / hull_area, 0.0, 1.0))

    base = 0.035 * min_side
    if circularity < 0.45 or solidity < 0.85:
        base *= 1.6
    elif circularity > 0.7 and solidity > 0.95:
        base *= 0.7

    # Cap so we never erase most of a small leaf (~15% of min side)
    suggested = int(round(base))
    return int(np.clip(suggested, min_px, min(max_px, max(min_px, min_side // 6))))


def crop_masked_leaf(hsi_cube, mask, shrink_px=0, sam_mask=None, brush_keep=None):
    """Erode mask by shrink_px (preserving edits), then crop to bbox."""
    working = apply_shrink_preserving_edits(
        mask, sam_mask=sam_mask, shrink_px=shrink_px, brush_keep=brush_keep
    )
    bbox = mask_bbox(working)
    if bbox is None:
        return None
    ymin, ymax, xmin, xmax = bbox
    masked_hsi = hsi_cube * (working[:, :, np.newaxis] > 0)
    return masked_hsi[ymin : ymax + 1, xmin : xmax + 1, :]


def rgb_crop_preview(rgb_image, mask, shrink_px=0, sam_mask=None, brush_keep=None):
    """Rectangular RGB preview matching what crop_masked_leaf will export."""
    working = apply_shrink_preserving_edits(
        mask, sam_mask=sam_mask, shrink_px=shrink_px, brush_keep=brush_keep
    )
    bbox = mask_bbox(working)
    if bbox is None:
        return None
    ymin, ymax, xmin, xmax = bbox
    masked = rgb_image.copy()
    masked[working == 0] = 0
    return masked[ymin : ymax + 1, xmin : xmax + 1]


def save_leaf(hsi, vine_type, main_label, sublabel):
    """Save ENVI .hdr (+ binary) and RGB .png under vine_type/label/sublabel/."""
    out_dir = OUTPUT_BASE_DIR / vine_type / main_label / sublabel
    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / f"{sublabel}.png"
    hdr_path = out_dir / f"{sublabel}.hdr"
    spectral.save_rgb(str(png_path), hsi, RGB_BANDS)
    envi.save_image(
        str(hdr_path),
        np.asarray(hsi),
        dtype=np.float32,
        force=True,
        ext=".img",
        interleave="bil",
    )
    return out_dir


def next_pending_folder(subfolders, vine_type, current, progress_data):
    """Return the next non-Completed folder after current, else the next folder."""
    if not subfolders:
        return None
    try:
        start = subfolders.index(current)
    except ValueError:
        start = -1
    for i in range(1, len(subfolders)):
        cand = subfolders[(start + i) % len(subfolders)]
        key = f"{vine_type}/{cand}"
        if progress_data.get(key, {}).get("status") != "Completed":
            return cand
    if len(subfolders) <= 1:
        return None
    return subfolders[(start + 1) % len(subfolders)]


POINT_RADIUS = 8
POINT_STROKE = 2
POINT_HIT_RADIUS = 22


def seed_to_canvas_object(cx, cy):
    return {
        "type": "circle",
        "left": float(cx) - (POINT_RADIUS + POINT_STROKE / 2),
        "top": float(cy),
        "originX": "left",
        "originY": "center",
        "strokeWidth": POINT_STROKE,
        "stroke": "#00FF00",
        "fill": "rgba(0, 255, 0, 0.85)",
        "selectable": False,
        "evented": False,
        "radius": POINT_RADIUS,
    }


def canvas_object_to_point(obj):
    radius = float(obj.get("radius", POINT_RADIUS)) * float(obj.get("scaleX", 1))
    stroke = float(obj.get("strokeWidth", POINT_STROKE))
    left = float(obj.get("left", 0))
    top = float(obj.get("top", 0))
    origin_x = obj.get("originX", "left")
    origin_y = obj.get("originY", "center")
    cx = left + radius + stroke / 2 if origin_x == "left" else left
    cy = top if origin_y == "center" else top + radius
    return (int(round(cx)), int(round(cy)))


def nearest_seed_index(point, seeds, max_dist=POINT_HIT_RADIUS):
    px, py = point
    best_i, best_d = None, max_dist
    for i, (sx, sy) in enumerate(seeds):
        dist = ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
        if dist <= best_d:
            best_i, best_d = i, dist
    return best_i


def clear_sam2_preview():
    st.session_state.sam2_masks = None
    st.session_state.sam2_centroids = None
    st.session_state.sam2_seeds = None
    st.session_state.edited_masks = None
    st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
    for k in list(st.session_state.keys()):
        sk = str(k)
        if sk.startswith("mask_undo_") or sk.startswith("mask_redo_"):
            del st.session_state[k]


def mask_edit_region(mask, margin=48):
    """BBox around mask expanded by margin so the brush can paint outside the leaf."""
    h, w = mask.shape[:2]
    bbox = mask_bbox(mask)
    if bbox is None:
        return 0, h - 1, 0, w - 1
    ymin, ymax, xmin, xmax = bbox
    return (
        max(0, ymin - margin),
        min(h - 1, ymax + margin),
        max(0, xmin - margin),
        min(w - 1, xmax + margin),
    )


def contrast_overlay_color(rgb_image, mask, y0, y1, x0, x1):
    """
    Pick a vivid overlay color that contrasts with the masked object.
    Uses mean object color in HSV, then shifts hue ~180° and boosts saturation.
    """
    crop = rgb_image[y0 : y1 + 1, x0 : x1 + 1]
    m = mask[y0 : y1 + 1, x0 : x1 + 1]
    pixels = crop[m == 255]
    if pixels.size == 0:
        return np.array([255, 64, 255], dtype=np.float32)  # fallback magenta

    mean_bgr = pixels.mean(axis=0).astype(np.uint8).reshape(1, 1, 3)
    # rgb_image from HSI bands is RGB-ordered (not OpenCV BGR)
    mean_rgb = mean_bgr  # already RGB in this pipeline
    hsv = cv2.cvtColor(mean_rgb, cv2.COLOR_RGB2HSV).astype(np.float32)[0, 0]
    h, s, v = float(hsv[0]), float(hsv[1]), float(hsv[2])

    # Opposite hue on OpenCV's 0–179 scale
    h = (h + 90.0) % 180.0
    s = max(160.0, min(255.0, s * 1.4 + 40.0))
    v = max(180.0, min(255.0, v * 0.5 + 140.0))

    contrast_hsv = np.array([[[h, s, v]]], dtype=np.uint8)
    contrast_rgb = cv2.cvtColor(contrast_hsv, cv2.COLOR_HSV2RGB)[0, 0]
    return contrast_rgb.astype(np.float32)


def make_brush_background(rgb_image, mask, y0, y1, x0, x1, overlay_rgb=None):
    """RGB crop with a tint over the mask using a contrasting color."""
    crop = rgb_image[y0 : y1 + 1, x0 : x1 + 1].copy()
    m = mask[y0 : y1 + 1, x0 : x1 + 1]
    if overlay_rgb is None:
        overlay_rgb = contrast_overlay_color(rgb_image, mask, y0, y1, x0, x1)
    tint = crop.astype(np.float32)
    # Stronger tint so the current mask reads clearly while editing
    tint[m == 255] = tint[m == 255] * 0.48 + overlay_rgb.reshape(1, 3) * 0.52
    return tint.astype(np.uint8), overlay_rgb


def apply_brush_stroke(mask, stroke_rgba, y0, y1, x0, x1, mode="add"):
    """Apply canvas stroke onto mask. mode 'add' → 255; 'erase' → 0."""
    if stroke_rgba is None or stroke_rgba.size == 0:
        return False
    region_h, region_w = y1 - y0 + 1, x1 - x0 + 1
    stroke = stroke_rgba
    alpha = stroke[:, :, 3] if stroke.shape[2] >= 4 else np.full(stroke.shape[:2], 255)

    # Threshold in display space first so thin strokes aren't lost when downscaling
    paint = (alpha > 8).astype(np.uint8) * 255
    if paint.shape[0] != region_h or paint.shape[1] != region_w:
        # Slight dilate so 1px display marks survive nearest/area downsample
        if max(paint.shape) > max(region_h, region_w) * 1.5:
            paint = cv2.dilate(paint, np.ones((3, 3), np.uint8), iterations=1)
        paint = cv2.resize(paint, (region_w, region_h), interpolation=cv2.INTER_AREA)
        paint = (paint > 20).astype(bool)
    else:
        paint = paint > 0

    if not np.any(paint):
        return False
    patch = mask[y0 : y1 + 1, x0 : x1 + 1]
    if mode == "erase":
        patch[paint] = 0
    else:
        patch[paint] = 255
    mask[y0 : y1 + 1, x0 : x1 + 1] = patch
    return True


def brush_size_swatch(diameter_px, rgb=(0, 220, 120), canvas_side=72):
    """Always-visible circle showing the current brush diameter."""
    d = max(4, int(diameter_px))
    side = int(canvas_side)
    img = np.full((side, side, 3), 36, dtype=np.uint8)
    r, g, b = [int(c) for c in rgb]
    show_r = max(2, min(d, side - 6) // 2)
    center = (side // 2, side // 2)
    overlay = img.copy()
    cv2.circle(overlay, center, show_r, (r, g, b), -1)
    img = cv2.addWeighted(img, 0.55, overlay, 0.45, 0)
    cv2.circle(img, center, show_r, (r, g, b), 2)
    cv2.circle(img, center, 1, (255, 255, 255), -1)
    return img


def inject_brush_cursor(diameter_px, mode="Add", overlay_rgb=None):
    """
    Circular brush cursor over the edit canvas.

    streamlit-drawable-canvas draws inside a component iframe, so parent-page
    CSS alone never reaches it. We inject the cursor rule into every iframe
    (and retry after mount).
    """
    d = int(np.clip(int(diameter_px), 8, 128))
    if mode == "Erase":
        r, g, b = 255, 70, 70
    elif overlay_rgb is not None:
        r, g, b = [int(c) for c in overlay_rgb]
    else:
        r, g, b = 0, 220, 120

    half = d / 2.0
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{d}" height="{d}" '
        f'viewBox="0 0 {d} {d}">'
        f'<circle cx="{half}" cy="{half}" r="{max(1, half - 1.5)}" '
        f'fill="rgba({r},{g},{b},0.22)" stroke="rgba({r},{g},{b},0.95)" '
        f'stroke-width="2"/></svg>'
    )
    url = "data:image/svg+xml," + quote(svg)
    hot = d // 2
    css_rule = (
        f'canvas, .upper-canvas, .lower-canvas, .canvas-container, '
        f'.canvas-container * {{ cursor: url("{url}") {hot} {hot}, '
        f"crosshair !important; }}"
    )

    st.markdown(
        f"""
        <style>
        [data-testid="stDialog"] .canvas-container,
        [data-testid="stDialog"] .canvas-container *,
        [data-testid="stDialog"] canvas,
        [role="dialog"] .canvas-container,
        [role="dialog"] .canvas-container *,
        [role="dialog"] canvas {{
            cursor: url("{url}") {hot} {hot}, crosshair !important;
        }}
        </style>
        """,
        unsafe_allow_html=True,
    )

    # Punch cursor CSS into component iframes (where Fabric actually lives)
    cursor_value = f'url("{url}") {hot} {hot}, crosshair'
    st.html(
        f"""
        <script>
        (function() {{
          const RULE = {css_rule!r};
          const CURSOR = {cursor_value!r};
          const STYLE_ID = "hsi-brush-cursor-style";

          function applyTo(doc) {{
            if (!doc || !doc.head) return;
            let style = doc.getElementById(STYLE_ID);
            if (!style) {{
              style = doc.createElement("style");
              style.id = STYLE_ID;
              doc.head.appendChild(style);
            }}
            style.textContent = RULE;
            try {{
              doc.querySelectorAll("canvas.upper-canvas, canvas.lower-canvas, canvas").forEach(function(c) {{
                c.style.setProperty("cursor", CURSOR, "important");
              }});
            }} catch (e) {{}}
          }}

          function applyAll() {{
            applyTo(document);
            document.querySelectorAll("iframe").forEach(function(frame) {{
              try {{
                applyTo(frame.contentDocument);
              }} catch (e) {{}}
            }});
          }}

          applyAll();
          setTimeout(applyAll, 200);
          setTimeout(applyAll, 600);
          setTimeout(applyAll, 1200);
        }})();
        </script>
        """,
        unsafe_allow_javascript=True,
    )


def downscale_max(img, max_side=320):
    h, w = img.shape[:2]
    scale = min(1.0, float(max_side) / max(h, w))
    if scale >= 0.999:
        return img
    return cv2.resize(
        img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA
    )


def _undo_key(sample, old_idx):
    return f"mask_undo_{sample}_{old_idx}"


def _redo_key(sample, old_idx):
    return f"mask_redo_{sample}_{old_idx}"


def push_mask_undo(sample, old_idx):
    stack = st.session_state.setdefault(_undo_key(sample, old_idx), [])
    stack.append(st.session_state.edited_masks[old_idx].copy())
    if len(stack) > 40:
        del stack[0]
    st.session_state[_redo_key(sample, old_idx)] = []


def undo_mask_edit(sample, old_idx):
    stack = st.session_state.get(_undo_key(sample, old_idx), [])
    if not stack:
        return False
    redo = st.session_state.setdefault(_redo_key(sample, old_idx), [])
    redo.append(st.session_state.edited_masks[old_idx].copy())
    st.session_state.edited_masks[old_idx] = stack.pop()
    return True


def redo_mask_edit(sample, old_idx):
    redo = st.session_state.get(_redo_key(sample, old_idx), [])
    if not redo:
        return False
    stack = st.session_state.setdefault(_undo_key(sample, old_idx), [])
    stack.append(st.session_state.edited_masks[old_idx].copy())
    st.session_state.edited_masks[old_idx] = redo.pop()
    return True


@st.dialog("Edit leaf mask", width="large")
def mask_edit_dialog():
    """Modal brush editor with Add/Erase and mask-level undo/redo."""
    sample = st.session_state.dialog_sample_key
    old_idx = st.session_state.dialog_old_idx
    label_txt = st.session_state.dialog_label
    rgb = st.session_state.dialog_rgb
    sam_masks = st.session_state.dialog_sam_masks

    edit_mask = st.session_state.edited_masks[old_idx]
    y0, y1, x0, x1 = mask_edit_region(edit_mask, margin=56)
    brush_bg, overlay_rgb = make_brush_background(rgb, edit_mask, y0, y1, x0, x1)
    ch, cw = brush_bg.shape[:2]

    # Upscale with nearest-neighbor so the editor is large and pixel edges are visible
    target_max = 900
    scale = max(target_max / max(ch, cw), 3.0)
    disp_w = max(1, int(round(cw * scale)))
    disp_h = max(1, int(round(ch * scale)))
    brush_bg_disp = cv2.resize(
        brush_bg, (disp_w, disp_h), interpolation=cv2.INTER_NEAREST
    )

    st.markdown(
        f"**{label_txt}** — paint to add or erase. "
        "Brush size is shown beside the slider and as the cursor over the image. "
        "Use **Undo / Redo** below (not the canvas toolbar)."
    )

    mode_col, size_col, swatch_col = st.columns([1, 1.4, 0.55])
    with mode_col:
        brush_mode = st.radio(
            "Mode",
            ["Add", "Erase"],
            horizontal=True,
            key=f"dlg_mode_{sample}_{old_idx}",
        )
    with size_col:
        brush_size = st.slider(
            "Brush size (mask px)",
            2,
            60,
            14,
            key=f"dlg_brush_size_{sample}",
        )

    stroke_w = max(1, int(round(brush_size * scale)))
    if brush_mode == "Erase":
        stroke_color = "rgba(255, 70, 70, 0.45)"
        swatch_rgb = (255, 70, 70)
    else:
        r, g, b = [int(c) for c in overlay_rgb]
        stroke_color = f"rgba({r}, {g}, {b}, 0.45)"
        swatch_rgb = (r, g, b)

    with swatch_col:
        st.caption("Brush")
        st.image(
            brush_size_swatch(stroke_w, swatch_rgb, canvas_side=72),
            width=72,
        )

    u_col, r_col, z_col, c_col = st.columns(4)
    with u_col:
        if st.button(
            "↩ Undo",
            use_container_width=True,
            disabled=not st.session_state.get(_undo_key(sample, old_idx)),
        ):
            if undo_mask_edit(sample, old_idx):
                st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
                st.rerun()
    with r_col:
        if st.button(
            "↪ Redo",
            use_container_width=True,
            disabled=not st.session_state.get(_redo_key(sample, old_idx)),
        ):
            if redo_mask_edit(sample, old_idx):
                st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
                st.rerun()
    with z_col:
        if st.button("Reset to SAM", use_container_width=True):
            push_mask_undo(sample, old_idx)
            st.session_state.edited_masks[old_idx] = sam_masks[old_idx].copy()
            st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
            st.rerun()
    with c_col:
        if st.button("Done", type="primary", use_container_width=True):
            st.session_state.show_mask_editor = False
            st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
            st.rerun()

    inject_brush_cursor(stroke_w, brush_mode, overlay_rgb)

    brush_result = st_canvas(
        fill_color="rgba(0, 0, 0, 0)",
        stroke_width=stroke_w,
        stroke_color=stroke_color,
        background_image=Image.fromarray(brush_bg_disp),
        drawing_mode="freedraw",
        key=f"dlg_brush_{sample}_{old_idx}_{st.session_state.get('brush_gen', 0)}",
        height=disp_h,
        width=disp_w,
        max_display_height=disp_h,
        return_image_data=True,
        update_streamlit=True,
    )

    if brush_result.image_data is not None:
        alpha = brush_result.image_data[:, :, 3]
        if np.any(alpha > 8):
            push_mask_undo(sample, old_idx)
            changed = apply_brush_stroke(
                st.session_state.edited_masks[old_idx],
                brush_result.image_data,
                y0,
                y1,
                x0,
                x1,
                mode="add" if brush_mode == "Add" else "erase",
            )
            if changed:
                st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
                st.rerun()
            else:
                stack = st.session_state.get(_undo_key(sample, old_idx), [])
                if stack:
                    stack.pop()


@st.dialog("Leaf preview", width="large")
def leaf_preview_dialog():
    label_txt = st.session_state.get("preview_modal_label", "Leaf")
    img = st.session_state.get("preview_modal_img")
    st.markdown(f"**{label_txt}**")
    if img is not None:
        st.image(img, width="stretch")
    if st.button("Close", use_container_width=True):
        st.session_state.show_leaf_preview = False
        st.rerun()


# ==========================================
# STREAMLIT UI & CONTROL FLOW
# ==========================================
sam2_predictor = load_sam2()
ocr_reader = load_ocr()
progress_data = load_progress()

# Narrow the sidebar so the main workspace gets more room;
# final-masks column fills the viewport height (internal scroll only).
st.markdown(
    """
    <style>
    section[data-testid="stSidebar"] {
        width: 240px !important;
        min-width: 240px !important;
        max-width: 240px !important;
    }
    section[data-testid="stSidebar"] > div {
        width: 240px !important;
    }
    /* 3rd main column bordered block = Final masks scroller */
    section.main div[data-testid="stHorizontalBlock"] > div:nth-child(3)
      div[data-testid="stVerticalBlockBorderWrapper"] {
        height: calc(100vh - 160px) !important;
        max-height: calc(100vh - 160px) !important;
    }
    section.main div[data-testid="stHorizontalBlock"] > div:nth-child(3)
      div[data-testid="stVerticalBlockBorderWrapper"] > div {
        height: 100% !important;
        max-height: 100% !important;
        overflow-y: auto !important;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.sidebar.title("🌿 HSI Curation Pipeline")

# 1. Dataset Selection & Progress Overview
selected_type = st.sidebar.selectbox("Select Vine Type", list(IMAGES.keys()))
base_path = Path(IMAGES[selected_type])

subfolders = [
    f.name
    for f in base_path.iterdir()
    if f.is_dir() and f.name != "results" and (f / f"{f.name}.png").exists()
]
subfolders.sort()

completed_count = sum(
    1
    for sf in subfolders
    if progress_data.get(f"{selected_type}/{sf}", {}).get("status") == "Completed"
)
st.sidebar.progress(
    completed_count / max(len(subfolders), 1),
    text=f"Progress: {completed_count}/{len(subfolders)} Completed",
)

folder_widget_key = f"folder_select_{selected_type}"
# Advance to next sample after save/skip
if st.session_state.pop("advance_folder", None):
    target = st.session_state.pop("advance_folder_target", None)
    if target and target in subfolders:
        st.session_state[folder_widget_key] = target

if not subfolders:
    st.error("No sample folders found for this vine type.")
    st.stop()

if folder_widget_key not in st.session_state:
    # Prefer first pending sample
    first_pending = next(
        (
            sf
            for sf in subfolders
            if progress_data.get(f"{selected_type}/{sf}", {}).get("status")
            != "Completed"
        ),
        subfolders[0],
    )
    st.session_state[folder_widget_key] = first_pending
elif st.session_state[folder_widget_key] not in subfolders:
    st.session_state[folder_widget_key] = subfolders[0]

selected_folder = st.sidebar.selectbox(
    "Select Folder Sample", subfolders, key=folder_widget_key
)
sample_key = f"{selected_type}/{selected_folder}"

folder_path = base_path / selected_folder
png_path = folder_path / f"{selected_folder}.png"
hdr_path = folder_path / "results" / f"REFLECTANCE_{selected_folder}.hdr"

status = progress_data.get(sample_key, {}).get("status", "Unprocessed")
if status == "Completed":
    st.sidebar.success("Status: Completed ✅")
elif status == "Skipped":
    st.sidebar.warning("Status: Skipped")
else:
    st.sidebar.info("Status: Pending ⏳")

st.header(f"Processing: {selected_type} — Sample {selected_folder}")


@st.cache_data
def load_sample_data(png_p, hdr_p):
    png_img = cv2.imread(str(png_p))
    header = spectral.open_image(str(hdr_p))
    cube = header.load()
    cube = np.rot90(cube, k=3)
    return png_img, cube


png_img, hsi_cube = load_sample_data(png_path, hdr_path)

rgb_image = hsi_cube[:, :, RGB_BANDS].astype(np.float32)
peak = float(rgb_image.max()) if rgb_image.size else 0.0
rgb_image = (
    (rgb_image / peak * 255).astype(np.uint8)
    if peak > 0
    else np.zeros_like(rgb_image, dtype=np.uint8)
)

# Per-sample session keys
ocr_cache_key = f"ocr_{sample_key}"
main_label_key = f"main_label_{sample_key}"
sublabels_key = f"sublabels_{sample_key}"


def run_ocr_for_sample():
    auto_label, auto_sublabels = extract_labels(png_img, ocr_reader)
    used_previous_main = False
    if auto_label:
        detected_main = auto_label[0]
        st.session_state["last_main_label"] = detected_main
    else:
        # Keep the last successfully detected (or manually set) folder label
        previous = st.session_state.get("last_main_label")
        if previous:
            detected_main = previous
            used_previous_main = True
        else:
            detected_main = selected_folder
    st.session_state[ocr_cache_key] = {
        "main": detected_main,
        "sublabels": auto_sublabels,
        "found_sticky_note": bool(auto_label or auto_sublabels),
        "found_main_label": bool(auto_label),
        "used_previous_main": used_previous_main,
    }
    return st.session_state[ocr_cache_key]


if st.session_state.pop("force_ocr_reset", False) or ocr_cache_key not in st.session_state:
    run_ocr_for_sample()
    ocr_result = st.session_state[ocr_cache_key]
    st.session_state[main_label_key] = ocr_result["main"]
    st.session_state[sublabels_key] = ", ".join(ocr_result["sublabels"])

ocr_result = st.session_state[ocr_cache_key]
if main_label_key not in st.session_state:
    st.session_state[main_label_key] = ocr_result["main"]
if sublabels_key not in st.session_state:
    st.session_state[sublabels_key] = ", ".join(ocr_result["sublabels"])

# ------------------------------------------
# Sidebar: OCR, seed prompts, crop padding
# ------------------------------------------
st.sidebar.markdown("---")
st.sidebar.subheader("OCR Labels")
detected = ocr_result["sublabels"] or ["(none)"]
st.sidebar.caption(
    f"Detected `{ocr_result['main']}` / leaves: {', '.join(detected)}"
)
if ocr_result.get("used_previous_main"):
    st.sidebar.info(
        f"OCR missed the folder label — keeping previous: `{ocr_result['main']}`"
    )
elif not ocr_result["found_sticky_note"]:
    st.sidebar.warning("No sticky-note text found — edit labels below.")

main_label = st.sidebar.text_input(
    "Primary Folder Label",
    key=main_label_key,
    help="Filled automatically from the sticky note. Edit if OCR is wrong.",
)
# Carry the current folder label forward for samples where OCR misses it
if main_label:
    st.session_state["last_main_label"] = main_label
sublabels_text = st.sidebar.text_input(
    "Leaf Labels (Comma Separated)",
    key=sublabels_key,
    help="Filled automatically from OCR. Edit, add, or reorder as needed.",
)
if st.sidebar.button("🔄 Re-detect OCR labels"):
    st.session_state.force_ocr_reset = True
    st.rerun()
sublabels = [s.strip() for s in sublabels_text.split(",") if s.strip()]

st.sidebar.markdown("---")
st.sidebar.subheader("Seed Prompts")
ndvi_thresh = st.sidebar.slider("NDVI Threshold", 0.1, 0.8, 0.4, step=0.05)
min_distance = st.sidebar.slider("Min Peak Distance", 10, 100, 30, step=5)
if st.sidebar.button("Reset Seed Prompts"):
    st.session_state.seed_points = get_sam2_seed_prompts(
        hsi_cube, ndvi_thresh, min_distance
    )
    st.session_state.canvas_gen = st.session_state.get("canvas_gen", 0) + 1
    st.session_state.sam2_seeds = None
    st.rerun()
if st.sidebar.button(
    "Re-suggest leaf borders",
    help="Recompute border remove for each leaf from its SAM mask (you can still edit).",
):
    st.session_state[f"resuggest_shrink_{sample_key}"] = True
    for k in list(st.session_state.keys()):
        if str(k).startswith(f"shrink_{sample_key}_"):
            del st.session_state[k]
    st.rerun()

# Initialize seeds when the sample changes
if st.session_state.get("active_sample") != sample_key:
    st.session_state.active_sample = sample_key
    st.session_state.seed_points = get_sam2_seed_prompts(
        hsi_cube, ndvi_thresh, min_distance
    )
    st.session_state.canvas_gen = st.session_state.get("canvas_gen", 0) + 1
    clear_sam2_preview()
    for k in list(st.session_state.keys()):
        sk = str(k)
        if (
            sk.startswith("shrink_")
            or sk.startswith("leaf_shrinks_")
            or sk.startswith("resuggest_shrink_")
            or sk.startswith("mask_undo_")
            or sk.startswith("mask_redo_")
        ):
            del st.session_state[k]
    st.session_state.show_mask_editor = False
    st.session_state.show_leaf_preview = False

if "seed_points" not in st.session_state:
    st.session_state.seed_points = []

# Auto-run SAM before layout so Skip/Save can sit under the seed canvas
seed_tuple = tuple(st.session_state.seed_points)
needs_sam = (
    bool(st.session_state.seed_points)
    and st.session_state.get("sam2_seeds") != seed_tuple
)

if needs_sam:
    with st.spinner("Updating SAM 2 segmentation…"):
        masks, centroids = run_sam2_inference(
            sam2_predictor, rgb_image, st.session_state.seed_points
        )
    st.session_state.sam2_masks = masks
    st.session_state.sam2_centroids = centroids
    st.session_state.sam2_seeds = seed_tuple
    st.session_state.edited_masks = [m.copy() for m in masks]
    st.session_state.brush_gen = st.session_state.get("brush_gen", 0) + 1
    st.session_state.show_mask_editor = False
    for k in list(st.session_state.keys()):
        sk = str(k)
        if sk.startswith("mask_undo_") or sk.startswith("mask_redo_"):
            del st.session_state[k]

masks = st.session_state.get("sam2_masks")
centroids = st.session_state.get("sam2_centroids")
seeds_match = st.session_state.get("sam2_seeds") == seed_tuple

if (
    st.session_state.get("edited_masks") is None
    and masks is not None
    and seeds_match
):
    st.session_state.edited_masks = [m.copy() for m in masks]
edited_masks = st.session_state.get("edited_masks")

crop_previews = []
overlay_small = None
sorted_centroids = []
n_leaves = 0
shrink_state_key = f"leaf_shrinks_{sample_key}"

if masks is not None and centroids is not None:
    img_h, img_w = hsi_cube.shape[:2]
    mid_x = img_w / 2

    def leaf_position_key(item):
        idx, cy, cx = item
        if cy > 0.65 * img_h and (0.35 * img_w < cx < 0.65 * img_w):
            return (2, 0)
        return (0, cy) if cx < mid_x else (1, cy)

    sorted_centroids = sorted(centroids, key=leaf_position_key)
    n_leaves = len(sorted_centroids)
    force_smart = st.session_state.pop(f"resuggest_shrink_{sample_key}", False)

    for idx, (old_idx, _, _) in enumerate(sorted_centroids):
        widget_key = f"shrink_{sample_key}_{idx}"
        if force_smart or widget_key not in st.session_state:
            base = (
                edited_masks[old_idx]
                if edited_masks is not None
                else masks[old_idx]
            )
            st.session_state[widget_key] = suggest_mask_shrink(base)

    leaf_shrinks = [
        int(st.session_state[f"shrink_{sample_key}_{idx}"])
        for idx in range(n_leaves)
    ]
    st.session_state[shrink_state_key] = leaf_shrinks

    overlay = rgb_image.copy()
    rng = np.random.default_rng(abs(hash(sample_key)) % (2**32))
    for idx, (old_idx, cy, cx) in enumerate(sorted_centroids):
        mask = (
            edited_masks[old_idx] if edited_masks is not None else masks[old_idx]
        )
        shrink = leaf_shrinks[idx]
        shrunk = apply_shrink_preserving_edits(
            mask, sam_mask=masks[old_idx], shrink_px=shrink
        )
        color = rng.integers(50, 255, size=3)

        removed = (mask == 255) & (shrunk == 0)
        overlay[removed] = overlay[removed] * 0.7 + np.array([80, 80, 80]) * 0.3
        overlay[shrunk == 255] = overlay[shrunk == 255] * 0.4 + color * 0.6

        contours, _ = cv2.findContours(
            shrunk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if contours:
            cv2.drawContours(
                overlay, contours, -1, tuple(int(c) for c in color), 2
            )

        label_txt = sublabels[idx] if idx < len(sublabels) else f"#{idx + 1}"
        cv2.circle(overlay, (int(cx), int(cy)), 6, (255, 255, 255), -1)
        cv2.putText(
            overlay,
            str(label_txt),
            (int(cx) + 10, int(cy) + 5),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
        )
        preview = rgb_crop_preview(
            rgb_image, mask, shrink_px=shrink, sam_mask=masks[old_idx]
        )
        if preview is not None:
            crop_previews.append((label_txt, preview, idx, shrink, old_idx))
    overlay_small = downscale_max(overlay.astype(np.uint8), max_side=380)

# ==========================================
# MAIN VIEW: seeds | SAM overview | final masks
# ==========================================
view_col1, view_col2, view_col3 = st.columns([0.95, 1.35, 0.9])

with view_col1:
    st.subheader("1. Centroids")
    st.caption(
        "Click to **add** / click a green dot to **remove**. "
        f"Auto seeds only if under {MAX_AUTO_CENTROIDS + 1} peaks."
    )
    n_seeds = len(st.session_state.seed_points)
    st.caption(f"{n_seeds} centroid(s)")
    if n_seeds == 0:
        st.info("Click the image to place seeds, or reset prompts.")

    canvas_h, canvas_w = rgb_image.shape[:2]
    canvas_result = st_canvas(
        fill_color="rgba(0, 255, 0, 0.85)",
        stroke_width=POINT_STROKE,
        stroke_color="#00FF00",
        background_image=Image.fromarray(rgb_image),
        drawing_mode="point",
        point_display_radius=POINT_RADIUS,
        initial_drawing={
            "objects": [
                seed_to_canvas_object(cx, cy) for cx, cy in st.session_state.seed_points
            ]
        },
        key=f"canvas_{sample_key}_{st.session_state.get('canvas_gen', 0)}",
        height=canvas_h,
        width=canvas_w,
        max_display_height=360,
    )

    if canvas_result.json_data is not None:
        objects = canvas_result.json_data.get("objects", [])
        n_known = len(st.session_state.seed_points)
        extra = objects[n_known:]
        if extra:
            for obj in extra:
                click_pt = canvas_object_to_point(obj)
                hit_idx = nearest_seed_index(click_pt, st.session_state.seed_points)
                if hit_idx is not None:
                    st.session_state.seed_points.pop(hit_idx)
                else:
                    st.session_state.seed_points.append(click_pt)
            st.session_state.canvas_gen = st.session_state.get("canvas_gen", 0) + 1
            st.rerun()

    skip_col, save_col = st.columns(2)
    with skip_col:
        if st.button("Skip", use_container_width=True):
            progress_data[sample_key] = {"status": "Skipped"}
            save_progress(progress_data)
            nxt = next_pending_folder(
                subfolders, selected_type, selected_folder, progress_data
            )
            if nxt:
                st.session_state.advance_folder = True
                st.session_state.advance_folder_target = nxt
            st.rerun()
    with save_col:
        if st.button(
            "Save ▶",
            type="primary",
            use_container_width=True,
            disabled=not (seeds_match and masks is not None and n_leaves > 0),
        ):
            leaf_shrinks = [
                int(st.session_state[f"shrink_{sample_key}_{idx}"])
                for idx in range(n_leaves)
            ]
            saved_dirs = []
            for new_id, (old_idx, cy, cx) in enumerate(sorted_centroids):
                label_str = (
                    sublabels[new_id]
                    if (sublabels and new_id < len(sublabels))
                    else f"Leaf_{new_id + 1}"
                )
                leaf_mask = (
                    st.session_state.edited_masks[old_idx]
                    if st.session_state.get("edited_masks") is not None
                    else masks[old_idx]
                )
                cropped = crop_masked_leaf(
                    hsi_cube,
                    leaf_mask,
                    shrink_px=int(leaf_shrinks[new_id]),
                    sam_mask=masks[old_idx],
                )
                if cropped is not None:
                    out = save_leaf(
                        cropped, selected_type, main_label, label_str
                    )
                    saved_dirs.append(str(out))

            progress_data[sample_key] = {
                "status": "Completed",
                "main_label": main_label,
                "count": len(sorted_centroids),
            }
            save_progress(progress_data)

            nxt = next_pending_folder(
                subfolders, selected_type, selected_folder, progress_data
            )
            if nxt:
                st.session_state.advance_folder = True
                st.session_state.advance_folder_target = nxt
                st.success(
                    f"Saved {len(saved_dirs)} leaves. Moving to sample {nxt}."
                )
            else:
                st.success(
                    f"Saved {len(saved_dirs)} leaves. All samples completed."
                )
            st.rerun()

with view_col2:
    st.subheader("2. SAM 2 Preview")
    if not st.session_state.seed_points:
        st.info("Place at least one centroid to run segmentation.")
    elif masks is None or centroids is None:
        st.info("Waiting for SAM 2…")
    else:
        if not seeds_match:
            st.caption("Showing previous preview while updating…")
        if overlay_small is not None:
            st.image(overlay_small, width="stretch")

with view_col3:
    st.subheader("Final masks")
    # Tall scroll region; CSS clamps to viewport so the page itself need not scroll
    with st.container(height=900, border=True):
        if not crop_previews:
            st.caption("Masks appear after SAM runs.")
        for label_txt, preview, idx, shrink, old_idx in crop_previews:
            st.markdown(f"**{label_txt}**")
            st.image(
                downscale_max(preview, max_side=96),
                width="stretch",
            )
            st.number_input(
                "Border",
                min_value=0,
                max_value=50,
                step=1,
                key=f"shrink_{sample_key}_{idx}",
                help="Pixels removed inward from the mask edge.",
            )
            b1, b2 = st.columns(2)
            with b1:
                if st.button(
                    "Edit",
                    key=f"edit_btn_{sample_key}_{idx}",
                    use_container_width=True,
                    disabled=not seeds_match or edited_masks is None,
                ):
                    st.session_state.dialog_sample_key = sample_key
                    st.session_state.dialog_old_idx = old_idx
                    st.session_state.dialog_label = str(label_txt)
                    st.session_state.dialog_rgb = rgb_image
                    st.session_state.dialog_sam_masks = masks
                    st.session_state.show_mask_editor = True
                    st.rerun()
            with b2:
                if st.button(
                    "Expand",
                    key=f"exp_btn_{sample_key}_{idx}",
                    use_container_width=True,
                ):
                    cur_shrink = int(
                        st.session_state.get(
                            f"shrink_{sample_key}_{idx}", shrink
                        )
                    )
                    cur_mask = (
                        edited_masks[old_idx]
                        if edited_masks is not None
                        else masks[old_idx]
                    )
                    st.session_state.preview_modal_label = (
                        f"{label_txt} (−{cur_shrink}px)"
                    )
                    st.session_state.preview_modal_img = rgb_crop_preview(
                        rgb_image,
                        cur_mask,
                        shrink_px=cur_shrink,
                        sam_mask=masks[old_idx],
                    )
                    st.session_state.show_leaf_preview = True
                    st.rerun()
            st.divider()

    if crop_previews:
        leaf_shrinks = [
            int(st.session_state[f"shrink_{sample_key}_{idx}"])
            for idx in range(n_leaves)
        ]
        st.session_state[shrink_state_key] = leaf_shrinks

# Keep dialogs open across brush undo/redo reruns
if st.session_state.get("show_mask_editor"):
    mask_edit_dialog()
if st.session_state.get("show_leaf_preview"):
    leaf_preview_dialog()
