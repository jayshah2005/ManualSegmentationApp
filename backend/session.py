"""In-memory state for the single sample being segmented (one operator at a time).

Not a database: restarting the server clears the open sample. Progress and
exports persist on disk under the output folder (see ``pipeline.progress`` /
``pipeline.export``). Use ``SessionManager.locked()`` around multi-field updates.

Every object has a stable ``id`` (never reused within a sample) and carries its
own prompts so editing one object never disturbs the others.
"""
from __future__ import annotations

import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

import numpy as np

from backend.pipeline.discover import Sample
from backend.pipeline.loaders import ImageSource
from backend.pipeline.sam import Box, Point
from backend.settings import OrientationSettings


@dataclass
class ObjectState:
    id: int
    label: str = ""
    points: list[Point] = field(default_factory=list)
    box: Box | None = None
    sam_mask: np.ndarray | None = None
    edited_mask: np.ndarray | None = None  # sam_mask + brush edits
    brush_keep: np.ndarray | None = None  # brush-owned pixels, immune to border
    shrink: int = 0  # border px removed from the SAM mask

    def reset_edits(self) -> None:
        if self.sam_mask is not None:
            self.edited_mask = self.sam_mask.copy()
            self.brush_keep = np.zeros_like(self.sam_mask)


@dataclass
class Session:
    sample: Sample | None = None
    source: ImageSource | None = None
    rgb_image: np.ndarray | None = None  # uint8 (H, W, 3) shown on canvas + fed to SAM
    bands_used: list[int] = field(default_factory=list)
    image_token: str = ""  # changes whenever the displayed image changes
    # Orientation the canvas was built with; export must use the same one even if
    # the user changes the setting while this image is open.
    orientation: OrientationSettings = field(default_factory=OrientationSettings)
    objects: list[ObjectState] = field(default_factory=list)
    next_id: int = 1

    @property
    def info(self):
        """Cached ``SourceInfo`` of the open image (None when nothing is open)."""
        return self.source.info() if self.source else None

    @property
    def sample_key(self) -> str:
        return self.sample.key if self.sample else ""

    @property
    def height(self) -> int:
        return 0 if self.rgb_image is None else int(self.rgb_image.shape[0])

    @property
    def width(self) -> int:
        return 0 if self.rgb_image is None else int(self.rgb_image.shape[1])

    def new_object(self) -> ObjectState:
        obj = ObjectState(id=self.next_id)
        self.next_id += 1
        self.objects.append(obj)
        return obj

    def find(self, object_id: int) -> ObjectState | None:
        return next((o for o in self.objects if o.id == object_id), None)

    def start(
        self,
        sample: Sample,
        source: ImageSource,
        rgb: np.ndarray,
        bands: list[int],
        orientation: OrientationSettings,
    ) -> None:
        self.sample, self.source = sample, source
        self.orientation = orientation
        self.rgb_image, self.bands_used = rgb, bands
        self.image_token = uuid.uuid4().hex
        self.objects, self.next_id = [], 1


class SessionManager:
    """Thread-safe holder for the process-wide active ``Session``."""

    def __init__(self) -> None:
        self._session = Session()
        self._lock = threading.RLock()

    def get(self) -> Session:
        with self._lock:
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
