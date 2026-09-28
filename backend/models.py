"""Lazy SAM2 + EasyOCR holders shared across requests (GPU-heavy; load once).

First call to ``get_sam2`` / ``get_ocr`` downloads/warms weights — expect a pause.
``sam_lock`` serializes predicts so two concurrent seed updates cannot race the
predictor (single active session, but uvicorn may still overlap requests).
"""
from __future__ import annotations

import sys
import threading

import easyocr
import torch

from backend.config import SAM2_CHECKPOINT, SAM2_CONFIG, SAM2_DIR

# Prefer the editable SAM-2 package from uv; fall back to cloning the repo onto sys.path.
try:
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
except ImportError:
    sys.path.insert(0, str(SAM2_DIR))
    from sam2.build_sam import build_sam2  # noqa: E402
    from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: E402


class ModelRegistry:
    """Process-scoped models with double-checked locking and a SAM predict mutex."""

    def __init__(self) -> None:
        self._sam2: SAM2ImagePredictor | None = None
        self._ocr: easyocr.Reader | None = None
        self._load_lock = threading.Lock()
        self.sam_lock = threading.Lock()

    def load(self) -> None:
        """Optional eager warmup; getters also lazy-load on first use."""
        self.get_sam2()
        self.get_ocr()

    def get_sam2(self) -> SAM2ImagePredictor:
        if self._sam2 is None:
            with self._load_lock:
                if self._sam2 is None:
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                    model = build_sam2(SAM2_CONFIG, str(SAM2_CHECKPOINT), device=device)
                    self._sam2 = SAM2ImagePredictor(model)
        return self._sam2

    def get_ocr(self) -> easyocr.Reader:
        if self._ocr is None:
            with self._load_lock:
                if self._ocr is None:
                    use_gpu = torch.cuda.is_available()
                    self._ocr = easyocr.Reader(["en"], gpu=use_gpu)
        return self._ocr
