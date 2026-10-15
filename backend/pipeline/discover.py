"""Find samples (images/cubes) under the user's input folder.

One *sample* = one thing to segment. Rules that keep the list free of duplicates:

- an ENVI ``.hdr`` and its data file (.img/.raw/.dat/…) are a single sample
- a Specim IQ capture folder (``results/REFLECTANCE_*.hdr`` or ``capture/*.hdr``)
  is a single sample; its preview PNG and sibling files are ignored
- hidden files/folders and the output folder (if nested in the input) are skipped

``key`` is the POSIX path relative to the input root and is what progress and
the output folder structure are keyed by.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, replace
from pathlib import Path

from backend.pipeline.loaders import ENVI_EXTS, SUPPORTED_EXTS

_ENVI_DATA_EXTS = {"", ".img", ".raw", ".dat", ".bil", ".bip", ".bsq", ".bin"}


@dataclass(frozen=True)
class Sample:
    key: str  # relative path used as identity, e.g. "plot1/img_01.png"
    path: Path  # file to open (image, or .hdr for ENVI)
    format: str  # lower-case extension without dot ("png", "hdr", …)
    is_folder: bool = False  # True for Specim IQ capture folders
    out_rel: str = ""  # set when the default output folder would collide

    @property
    def name(self) -> str:
        return Path(self.key).name

    @property
    def parent(self) -> str:
        p = Path(self.key).parent.as_posix()
        return "" if p == "." else p

    @property
    def output_rel(self) -> str:
        """Relative output folder: the key without its file extension."""
        if self.out_rel:
            return self.out_rel
        if self.is_folder:
            return self.key
        return Path(self.key).with_suffix("").as_posix()


def _natural(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _specim_hdr(folder: Path) -> Path | None:
    results = folder / "results"
    if results.is_dir():
        hits = sorted(results.glob("REFLECTANCE_*.hdr"))
        if hits:
            return hits[0]
    capture = folder / "capture"
    if capture.is_dir():
        hits = sorted(h for h in capture.glob("*.hdr") if not h.name.startswith("."))
        if hits:
            return hits[0]
    return None


def _has_envi_data(hdr: Path) -> bool:
    stem = hdr.with_suffix("")
    if stem.is_file():  # extension-less data file
        return True
    for ext in _ENVI_DATA_EXTS - {""}:
        if stem.with_suffix(ext).is_file():
            return True
    return False


def discover(
    root: Path | str, recursive: bool = True, exclude: list[Path] | None = None
) -> list[Sample]:
    root_path = Path(root).expanduser().resolve()
    if not root_path.is_dir():
        raise NotADirectoryError(str(root_path))
    skip = [p.resolve() for p in (exclude or [])]
    samples: list[Sample] = []
    seen: set[Path] = set()  # real paths already walked (symlink cycles)

    def rel(p: Path) -> str:
        return p.relative_to(root_path).as_posix()

    def walk(folder: Path) -> None:
        real = folder.resolve()
        if real in seen:
            return
        seen.add(real)
        try:
            entries = sorted(os.scandir(folder), key=lambda e: _natural(e.name))
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name == "__MACOSX":
                continue
            path = Path(entry.path)
            if entry.is_dir():  # follows symlinks; `seen` stops cycles
                if any(path.resolve() == s for s in skip):
                    continue
                specim = _specim_hdr(path)
                if specim is not None:  # a capture folder is one sample, even when not recursive
                    samples.append(Sample(rel(path), specim, "hdr", is_folder=True))
                elif recursive:
                    walk(path)
                continue
            ext = path.suffix.lower()
            if ext not in SUPPORTED_EXTS:
                continue
            if ext in ENVI_EXTS and not _has_envi_data(path):
                continue
            samples.append(Sample(rel(path), path, ext.lstrip(".")))

    walk(root_path)
    samples.sort(key=lambda s: _natural(s.key))
    return _dedupe_output_dirs(samples)


def _dedupe_output_dirs(samples: list[Sample]) -> list[Sample]:
    """``x.png`` next to ``x.tif`` would share an output folder; add the extension to both."""
    counts: dict[str, int] = {}
    for s in samples:
        counts[s.output_rel.lower()] = counts.get(s.output_rel.lower(), 0) + 1
    out = []
    for s in samples:
        if counts[s.output_rel.lower()] > 1:
            s = replace(s, out_rel=f"{s.output_rel}_{s.format}")
        out.append(s)
    return out


class SampleIndex:
    """Cached scan of the input folder (invalidated when folders/options change)."""

    def __init__(self) -> None:
        self._sig: tuple | None = None
        self._samples: list[Sample] = []

    def scan(
        self, root: str, recursive: bool, output_dir: str = "", force: bool = False
    ) -> list[Sample]:
        sig = (root, recursive, output_dir)
        if force or sig != self._sig:
            exclude = [Path(output_dir)] if output_dir else []
            self._samples = discover(root, recursive, exclude)
            self._sig = sig
        return self._samples

    def find(self, root: str, recursive: bool, output_dir: str, key: str) -> Sample | None:
        for s in self.scan(root, recursive, output_dir):
            if s.key == key:
                return s
        # Folder contents may have changed since the last scan.
        return next((s for s in self.scan(root, recursive, output_dir, force=True) if s.key == key), None)
