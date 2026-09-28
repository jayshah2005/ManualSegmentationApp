"""Pydantic request bodies for session routes.

Field names use camelCase so they match the React client JSON without aliases.
See ``frontend/src/api/client.ts`` for the corresponding TypeScript types.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class SeedPoint(BaseModel):
    """Image-pixel seed (positive SAM prompt). Origin is top-left."""

    x: int
    y: int


class MaskUpdate(BaseModel):
    """One brush-edited mask keyed by ``maskIndex`` (not displayIndex)."""

    maskIndex: int
    maskPngBase64: str
    # Brush-owned pixels (optional). Border never fringes these.
    brushKeepPngBase64: str | None = None


class LoadRequest(BaseModel):
    """Open a vine/folder sample: OCR + NDVI seeds + SAM run on the server."""

    vineType: str
    folder: str
    ndviThresh: float = 0.4
    minDistance: int = 30
    # Optional carry-forward of the main folder name from the client (Save → next).
    mainLabel: str | None = None


class SeedsRequest(BaseModel):
    seeds: list[SeedPoint]
    runSam: bool = True  # False = store points only (rare; UI always re-runs SAM)
    sampleKey: str | None = None


class LabelsRequest(BaseModel):
    """Update main / per-leaf labels, or ``redetect=True`` to re-run sticky OCR."""

    mainLabel: str | None = None
    sublabels: list[str] | None = None
    redetect: bool = False
    sampleKey: str | None = None


class ShrinkRequest(BaseModel):
    """Border remove (px). Either one leaf, or ``resuggest`` for all leaves."""

    displayIndex: int | None = None
    shrink: int | None = None
    resuggest: bool = False
    sampleKey: str | None = None


class MasksRequest(BaseModel):
    masks: list[MaskUpdate] = Field(description="List of {maskIndex, maskPngBase64}")
    sampleKey: str | None = None


class SaveRequest(BaseModel):
    """Optional last-second overrides; frontend usually syncs masks first.

    ``complete`` True (default) marks the sample Completed and returns ``nextFolder``.
    False exports the same crops but marks Incomplete and returns ``nextFolder: null``
    so the UI stays on the current sample.

    ``forceOverwrite`` False (default) refuses with HTTP 409 ``would_overwrite`` when
    any leaf export folder already has files; True replaces them.
    """

    mainLabel: str | None = None
    sublabels: list[str] | None = None
    shrinks: list[int] | None = None
    masks: list[MaskUpdate] | None = None
    sampleKey: str | None = None
    complete: bool = True
    forceOverwrite: bool = False
