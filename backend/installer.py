"""Background jobs for the setup screen: install PyTorch / SAM 2, download a model.

One job runs at a time. Output lines are kept in memory and polled by the UI
(``GET /api/setup/job?since=N``), which keeps this simple and proxy-friendly.

PyTorch and SAM 2 are installed into the interpreter running the app (via ``uv
pip`` when available, else ``pip``) so there is nothing for the user to type.
"""
from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from backend import engine

# Official Meta repo pinned to a commit verified with this app. A zip archive means
# end users don't need git. (PyPI's "sam2" is a third-party fork: do not use it.)
SAM2_COMMIT = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
SAM2_ARCHIVE = f"https://github.com/facebookresearch/sam2/archive/{SAM2_COMMIT}.zip"
TORCH_INDEX = "https://download.pytorch.org/whl/{tag}"
MAX_LINES = 3000


@dataclass
class Step:
    label: str
    cmd: list[str] | None = None
    env: dict[str, str] = field(default_factory=dict)
    download: tuple[str, Path] | None = None  # (url, destination)


@dataclass
class Job:
    id: str
    kind: str
    status: str = "running"  # running | done | error
    step: str = ""
    lines: list[str] = field(default_factory=list)
    progress: float | None = None
    error: str = ""
    restart_required: bool = False
    started: float = field(default_factory=time.time)

    def log(self, line: str) -> None:
        self.lines.append(line.rstrip())
        if len(self.lines) > MAX_LINES:
            del self.lines[: len(self.lines) - MAX_LINES]

    def snapshot(self, since: int = 0) -> dict:
        return {
            "id": self.id, "kind": self.kind, "status": self.status, "step": self.step,
            "progress": self.progress, "error": self.error,
            "restartRequired": self.restart_required,
            "lines": self.lines[since:], "next": len(self.lines),
        }


def pip_command() -> list[str]:
    """Installer for the running interpreter: ``uv pip`` if present, else ``pip``."""
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", sys.executable]
    return [sys.executable, "-m", "pip", "install"]


def torch_step(tag: str) -> Step:
    cmd = pip_command() + ["torch", "torchvision"]
    if tag not in ("default", ""):
        # Only this index (as PyTorch documents): uv ranks --extra-index-url *above* the
        # default index, which would let PyPI's CUDA wheel win over the CPU build.
        cmd += ["--index-url", TORCH_INDEX.format(tag=tag)]
    return Step(f"Installing PyTorch ({tag})", cmd)


def sam2_step() -> Step:
    # SAM2_BUILD_CUDA=0 skips an optional compile step that needs a C++ toolchain.
    return Step("Installing SAM 2", pip_command() + [SAM2_ARCHIVE], {"SAM2_BUILD_CUDA": "0"})


def model_step(model: str) -> Step:
    variant = engine.SAM_VARIANTS[model]
    return Step(f"Downloading SAM 2.1 {variant.label} model", download=(variant.url, engine.download_target(model)))


class JobManager:
    def __init__(self) -> None:
        self._job: Job | None = None
        self._lock = threading.Lock()

    def current(self) -> Job | None:
        return self._job

    def start(self, kind: str, steps: list[Step]) -> Job:
        with self._lock:
            if self._job is not None and self._job.status == "running":
                raise RuntimeError("Another setup task is still running")
            job = Job(id=uuid.uuid4().hex[:8], kind=kind)
            self._job = job
        threading.Thread(target=self._run, args=(job, steps), daemon=True).start()
        return job

    def _run(self, job: Job, steps: list[Step]) -> None:
        torch_was_loaded = "torch" in sys.modules
        try:
            for i, step in enumerate(steps, start=1):
                job.step = f"{step.label} ({i}/{len(steps)})"
                job.progress = None
                job.log(f"==> {step.label}")
                if step.download:
                    _download(job, *step.download)
                else:
                    _run_cmd(job, step)
            importlib.invalidate_caches()
            job.restart_required = torch_was_loaded and any("torch" in (s.label or "").lower() for s in steps)
            job.step, job.progress, job.status = "Done", 1.0, "done"
            job.log("==> Finished")
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI verbatim
            job.status, job.error = "error", str(exc)
            job.log(f"!! {exc}")


def _run_cmd(job: Job, step: Step) -> None:
    assert step.cmd
    job.log("$ " + " ".join(step.cmd))
    try:
        proc = subprocess.Popen(
            step.cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, **step.env},
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start the installer: {exc}") from exc
    assert proc.stdout
    for line in proc.stdout:
        job.log(line)
    if proc.wait() != 0:
        raise RuntimeError(f"'{step.label}' failed (exit code {proc.returncode}). See the log above.")


def _download(job: Job, url: str, dest: Path, opener: Callable = urllib.request.urlopen) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    job.log(f"Downloading {url}")
    with opener(url, timeout=30) as resp, open(part, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                job.progress = done / total
        if total and done != total:
            raise RuntimeError("Download was incomplete. Check your connection and try again.")
    part.replace(dest)
    job.log(f"Saved {dest}")


def plan_steps(action: str, status: dict, torch_tag: str | None, model: str) -> list[Step]:
    """Turn a UI action into steps; ``setup_all`` only does what is still missing."""
    tag = torch_tag or status["recommendedTorch"]["tag"]
    if action == "install_torch":
        return [torch_step(tag)]
    if action == "install_sam2":
        return [sam2_step()]
    if action == "download_model":
        return [model_step(model)]
    if action == "setup_all":
        steps: list[Step] = []
        if not status["torch"]["installed"]:
            steps.append(torch_step(tag))
        if not status["sam2Installed"]:
            steps.append(sam2_step())
        if not any(m["name"] == model and m["downloaded"] for m in status["models"]):
            steps.append(model_step(model))
        return steps
    raise ValueError(f"Unknown setup action: {action}")
