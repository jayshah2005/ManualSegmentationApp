"""Sticky-note OCR: find the yellow note on the RGB PNG and read folder/leaf labels.

Returns (main_labels, sublabels). Convention: first valid token like ``AB123`` is the
folder label; remaining numeric tokens are per-leaf labels.
"""
from __future__ import annotations

import re

import cv2
import numpy as np


def extract_labels(img: np.ndarray, reader) -> tuple[list[str], list[str]]:
    """Detect yellow sticky note, OCR it, return ``([main], [leaf, ...])``.

    ``main`` looks like ``AB123`` (two letters + digits). Remaining pure-numeric
    tokens become per-leaf sublabels (sorted). Empty lists if no note found.
    """
    def detect_sticky_note(image):
        # Yellow sticky pad in HSV (OpenCV hue ~30–60).
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
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
        image_area = image.shape[0] * image.shape[1]
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
    # Upscale + adaptive threshold so EasyOCR can read small handwriting.
    resized = cv2.resize(gray, (0, 0), fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    processed_img = cv2.adaptiveThreshold(
        resized, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 4
    )

    allowed_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    results = reader.readtext(processed_img, allowlist=allowed_chars)

    label_pattern = re.compile(r"^[A-Za-z]{2}\d+$")
    number_pattern = re.compile(r"^\d+$")
    valid_entries = []

    for _, text, _prob in results:
        clean_text = text.strip()
        # Common OCR confusions on digits / short tokens.
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
