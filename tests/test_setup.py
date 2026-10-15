import sys
import time

import pytest

from backend import engine, installer
from backend.engine import recommend_torch


def smi(cuda, cc=None, name="GPU"):
    d = {"name": name, "driver": "1", "memoryMb": 1, "cudaVersion": cuda}
    if cc:
        d["computeCap"] = cc
    return d


@pytest.mark.parametrize("system,gpu,tag", [
    ("Darwin", None, "default"),
    ("Linux", None, "cpu"),
    ("Windows", smi("13.2", 12.0), "cu130"),
    ("Linux", smi("12.9", 8.6), "cu128"),
    ("Linux", smi("12.6", 8.0), "cu126"),
    ("Linux", smi("11.8", 8.0), "cpu"),          # driver too old
    ("Linux", smi("13.0", 6.1), "cu126"),        # Pascal needs the older wheels
])
def test_recommend_torch(system, gpu, tag):
    assert recommend_torch(system, gpu)["tag"] == tag


def test_torch_command_uses_pytorch_index():
    cmd = installer.torch_step("cu130").cmd
    assert "--index-url" in cmd and cmd[cmd.index("--index-url") + 1].endswith("/whl/cu130")
    assert "--index-url" not in installer.torch_step("default").cmd
    assert installer.SAM2_ARCHIVE.startswith("https://github.com/facebookresearch/sam2/")


def test_plan_only_missing_steps():
    status = {"torch": {"installed": True}, "sam2Installed": False,
              "models": [{"name": "base_plus", "downloaded": False}], "recommendedTorch": {"tag": "cpu"}}
    labels = [s.label for s in installer.plan_steps("setup_all", status, None, "base_plus")]
    assert len(labels) == 2 and "SAM 2" in labels[0] and "model" in labels[1]
    with pytest.raises(ValueError):
        installer.plan_steps("nope", status, None, "tiny")


def _wait(mgr):
    for _ in range(100):
        if mgr.current().status != "running":
            return mgr.current()
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_job_runs_and_reports_errors():
    mgr = installer.JobManager()
    mgr.start("t", [installer.Step("ok", [sys.executable, "-c", "print('hello')"])])
    job = _wait(mgr)
    assert job.status == "done" and any("hello" in l for l in job.lines)
    mgr.start("t", [installer.Step("bad", [sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"])])
    job = _wait(mgr)
    assert job.status == "error" and "exit code 3" in job.error


def test_download_progress_and_atomic_rename(tmp_path):
    class Resp:
        headers = {"Content-Length": "6"}
        def __init__(self): self.parts = [b"abc", b"def"]
        def read(self, n): return self.parts.pop(0) if self.parts else b""
        def __enter__(self): return self
        def __exit__(self, *a): pass
    job = installer.Job(id="x", kind="d")
    dest = tmp_path / "m" / "model.pt"
    installer._download(job, "http://x", dest, opener=lambda url, timeout: Resp())
    assert dest.read_bytes() == b"abcdef" and job.progress == 1.0 and not dest.with_suffix(".pt.part").exists()
