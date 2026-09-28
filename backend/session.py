"""In-memory state for the single active sample (one operator at a time).

Not a database — restarting uvicorn clears the open sample. Progress/exports
persist via ``pipeline.save`` under ``OUTPUT_BASE_DIR``. Use ``SessionManager.locked()``
around multi-field updates so SAM/OCR and HTTP handlers do not interleave.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

import numpy as np


@dataclass
class Session:
    """Everything needed to curate one ``vineType/folder`` sample.

    Indexing note:
    - ``sam_masks[i]`` / ``edited_masks[i]`` align with seed order (``maskIndex``).
    - ``sorted_centroids`` reorders for the UI; ``displayIndex`` indexes that list
      and ``leaf_shrinks``. Each centroid tuple is ``(maskIndex, cy, cx)``.
    """

    vine_type: str = ""
    folder: str = ""
    sample_key: str = ""
    png_img: np.ndarray | None = None  # camera RGB for OCR (BGR from OpenCV)
    hsi_cube: np.ndarray | None = None
    rgb_image: np.ndarray | None = None  # HSI-derived RGB for SAM + canvas
    seeds: list[tuple[int, int]] = field(default_factory=list)
    sam_masks: list[np.ndarray] | None = None
    edited_masks: list[np.ndarray] | None = None
    # Brush-owned pixels (immune to border). Same length/indexing as sam_masks.
    brush_keeps: list[np.ndarray] | None = None
    centroids: list[tuple[int, float, float]] | None = None
    sorted_centroids: list[tuple[int, float, float]] = field(default_factory=list)
    leaf_shrinks: list[int] = field(default_factory=list)
    main_label: str = ""
    sublabels: list[str] = field(default_factory=list)
    ocr_meta: dict[str, Any] = field(default_factory=dict)
    ndvi_thresh: float = 0.4
    min_distance: int = 30
    last_main_label: str = ""  # carried across samples when OCR misses the folder tag
    sam_busy: bool = False

    @property
    def height(self) -> int:
        if self.rgb_image is None:
            return 0
        return int(self.rgb_image.shape[0])

    @property
    def width(self) -> int:
        if self.rgb_image is None:
            return 0
        return int(self.rgb_image.shape[1])


class SessionManager:
    """Thread-safe holder for the process-wide active ``Session``."""

    def __init__(self) -> None:
        self._session = Session()
        self._lock = threading.Lock()

    def get(self) -> Session:
        with self._lock:
            return self._session

    def replace(self, session: Session) -> Session:
        with self._lock:
            self._session = session
            return self._session

    def update(self, **kwargs: Any) -> Session:
        with self._lock:
            for key, value in kwargs.items():
                setattr(self._session, key, value)
            return self._session

    @contextmanager
    def locked(self) -> Iterator[Session]:
        with self._lock:
            yield self._session