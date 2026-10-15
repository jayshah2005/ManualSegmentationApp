"""Pydantic request bodies. Field names are camelCase to match the React client."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PointIn(BaseModel):
    """Image-pixel prompt. ``label`` 1 = include this area, 0 = exclude it."""

    x: int
    y: int
    label: Literal[0, 1] = 1


class BoxIn(BaseModel):
    x0: int
    y0: int
    x1: int
    y1: int


class LoadRequest(BaseModel):
    sampleKey: str


class PromptsRequest(BaseModel):
    """Prompts for one object; at least one point or a box is required."""

    points: list[PointIn] = Field(default_factory=list)
    box: BoxIn | None = None
    sampleKey: str | None = None


class ObjectPatch(BaseModel):
    label: str | None = None
    shrink: int | None = Field(default=None, ge=0, le=50)
    sampleKey: str | None = None


class MaskUpdate(BaseModel):
    """One brush-edited mask for an object id."""

    objectId: int
    maskPngBase64: str
    brushKeepPngBase64: str | None = None


class MasksRequest(BaseModel):
    masks: list[MaskUpdate]
    sampleKey: str | None = None


class SaveRequest(BaseModel):
    """Export the current objects.

    ``complete`` True marks the sample Completed and returns ``nextSampleKey``;
    False marks it Incomplete and stays put. ``forceOverwrite`` False refuses with
    HTTP 409 ``would_overwrite`` when any target file already exists.
    """

    masks: list[MaskUpdate] | None = None
    sampleKey: str | None = None
    complete: bool = True
    forceOverwrite: bool = False
