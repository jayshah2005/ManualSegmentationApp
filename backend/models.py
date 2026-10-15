"""Lazy SAM 2 holder shared across requests (heavy; load once per model/device).

``torch`` and ``sam2`` are imported inside ``get_sam2`` so the backend starts
without them. ``sam_lock`` serialises predicts, and ``ensure_image`` keeps the
(expensive) image embedding so each extra click only costs a fast decode.
"""
from __future__ import annotations

import threading

from backend import engine


class ModelRegistry:
    def __init__(self) -> None:
        self._predictor = None
        self._key: tuple[str, str] | None = None
        self._image_token: str | None = None
        self._load_lock = threading.Lock()
        self.sam_lock = threading.Lock()

    def get_sam2(self, model: str, device_pref: str):
        key = (model, device_pref)
        if self._predictor is not None and self._key == key:
            return self._predictor
        with self._load_lock:
            if self._predictor is not None and self._key == key:
                return self._predictor
            if importlib_missing("torch"):
                raise engine.EngineUnavailable("torch_missing", "PyTorch is not installed.")
            if not engine.ensure_sam2_importable():
                raise engine.EngineUnavailable("sam2_missing", "SAM 2 is not installed.")
            ckpt = engine.checkpoint_path(model)
            if ckpt is None:
                raise engine.EngineUnavailable(
                    "checkpoint_missing", f"The SAM 2.1 '{model}' model file is not downloaded."
                )
            from sam2.build_sam import build_sam2
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            device = engine.resolve_device(device_pref)
            net = build_sam2(engine.SAM_VARIANTS[model].config, str(ckpt), device=device)
            self._predictor = SAM2ImagePredictor(net)
            self._key = key
            self._image_token = None
            return self._predictor

    def ensure_image(self, predictor, token: str, rgb) -> None:
        """Embed ``rgb`` once per ``token`` (caller must hold ``sam_lock``)."""
        if self._image_token != token:
            predictor.set_image(rgb)
            self._image_token = token

    def release(self) -> None:
        """Drop the loaded model (e.g. after the user changes model size)."""
        with self._load_lock:
            self._predictor = None
            self._key = None
            self._image_token = None


def importlib_missing(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is None
