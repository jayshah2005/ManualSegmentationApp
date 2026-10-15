import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Keep settings/models out of the real user directory."""
    monkeypatch.setenv("SEGTOOL_HOME", str(tmp_path / "home"))
    yield
