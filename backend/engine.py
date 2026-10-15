"""Model "engine" status: is PyTorch / SAM 2 / a checkpoint available, and on what device?

Nothing here imports torch or sam2 at module load, so the app (and its setup
screen) boots on a machine that has neither installed. Heavy imports happen
inside functions and only when needed.
"""
from __future__ import annotations

import importlib.util
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from backend.settings import SamModel, models_dir

_REPO_ROOT = Path(__file__).resolve().parents[1]
_VENDORED_SAM2 = _REPO_ROOT / "third_party" / "sam2"

CHECKPOINT_BASE_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824"


@dataclass(frozen=True)
class SamVariant:
    name: SamModel
    label: str
    filename: str
    config: str
    size_mb: int
    note: str

    @property
    def url(self) -> str:
        return f"{CHECKPOINT_BASE_URL}/{self.filename}"


SAM_VARIANTS: dict[str, SamVariant] = {
    v.name: v
    for v in [
        SamVariant("tiny", "Tiny", "sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml", 156, "Fastest; fine for CPUs"),
        SamVariant("small", "Small", "sam2.1_hiera_small.pt", "configs/sam2.1/sam2.1_hiera_s.yaml", 185, "Fast, good quality"),
        SamVariant("base_plus", "Base+", "sam2.1_hiera_base_plus.pt", "configs/sam2.1/sam2.1_hiera_b+.yaml", 324, "Balanced (recommended)"),
        SamVariant("large", "Large", "sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml", 898, "Best quality; wants a GPU"),
    ]
}


class EngineUnavailable(Exception):
    """Segmentation cannot run yet. ``code`` tells the UI which setup step to show."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def ensure_sam2_importable() -> bool:
    """True if ``sam2`` can be imported (falls back to a vendored checkout for dev)."""
    if importlib.util.find_spec("sam2") is not None:
        return True
    if (_VENDORED_SAM2 / "sam2").is_dir():
        sys.path.insert(0, str(_VENDORED_SAM2))
        return importlib.util.find_spec("sam2") is not None
    return False


def checkpoint_path(model: str) -> Path | None:
    """First existing checkpoint for ``model``: app data dir, then vendored checkout."""
    variant = SAM_VARIANTS[model]
    for folder in (models_dir(), _VENDORED_SAM2 / "checkpoints"):
        candidate = folder / variant.filename
        if candidate.is_file() and candidate.stat().st_size > 1_000_000:
            return candidate
    return None


def download_target(model: str) -> Path:
    return models_dir() / SAM_VARIANTS[model].filename


def _nvidia_smi() -> dict | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8, check=True,
        ).stdout.strip().splitlines()
        name, driver, mem = [p.strip() for p in out[0].split(",")]
        return {"name": name, "driver": driver, "memoryMb": int(float(mem))}
    except (subprocess.SubprocessError, OSError, ValueError, IndexError):
        return None


def resolve_device(preference: str) -> str:
    """Map the user's device setting to what is actually available."""
    import torch

    has_cuda = torch.cuda.is_available()
    has_mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    if preference == "cuda":
        return "cuda" if has_cuda else "cpu"
    if preference == "mps":
        return "mps" if has_mps else "cpu"
    if preference == "cpu":
        return "cpu"
    return "cuda" if has_cuda else "mps" if has_mps else "cpu"


def system_status(selected_model: str, device_pref: str) -> dict:
    """Everything the setup screen / settings modal needs to explain GPU + SAM state."""
    torch_installed = importlib.util.find_spec("torch") is not None
    smi = _nvidia_smi()
    status: dict = {
        "os": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "nvidiaGpu": smi,
        "torch": {"installed": torch_installed},
        "sam2Installed": ensure_sam2_importable(),
        "models": [
            {
                "name": v.name, "label": v.label, "sizeMb": v.size_mb, "note": v.note,
                "downloaded": checkpoint_path(v.name) is not None,
            }
            for v in SAM_VARIANTS.values()
        ],
        "selectedModel": selected_model,
    }
    device = "none"
    problems: list[dict] = []
    if torch_installed:
        import torch

        build = torch.version.cuda
        cuda_ok = torch.cuda.is_available()
        device = resolve_device(device_pref)
        status["torch"].update(
            version=torch.__version__, cudaBuild=build, cudaAvailable=cuda_ok,
            mpsAvailable=bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
        )
        if cuda_ok:
            props = torch.cuda.get_device_properties(0)
            status["gpu"] = {"name": props.name, "memoryMb": int(props.total_memory / 2**20)}
        if smi and not cuda_ok:
            if build is None:
                problems.append({
                    "code": "cpu_only_torch",
                    "message": f"An NVIDIA GPU ({smi['name']}) was found, but the installed PyTorch is the CPU-only build.",
                    "fix": "install_torch",
                    "severity": "warning",
                })
            else:
                problems.append({
                    "code": "cuda_unavailable",
                    "message": "An NVIDIA GPU was found but PyTorch cannot use it. Update your NVIDIA driver or reinstall PyTorch.",
                    "fix": "install_torch",
                    "severity": "warning",
                })
    else:
        problems.append({
            "code": "torch_missing",
            "message": "PyTorch (the deep-learning engine) is not installed yet.",
            "fix": "install_torch",
            "severity": "blocking",
        })
    if torch_installed and not status["sam2Installed"]:
        problems.append({"code": "sam2_missing", "message": "SAM 2 is not installed.", "fix": "install_sam2", "severity": "blocking"})
    if checkpoint_path(selected_model) is None:
        problems.append({
            "code": "checkpoint_missing",
            "message": f"The SAM 2.1 {SAM_VARIANTS[selected_model].label} model file is not downloaded.",
            "fix": "download_model",
            "severity": "blocking",
        })
    status["device"] = device
    status["problems"] = problems
    status["ready"] = not any(p["severity"] == "blocking" for p in problems)
    return status
