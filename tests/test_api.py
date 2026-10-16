import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.models import ModelRegistry


class FakePredictor:
    """Stands in for SAM: returns a 20x20 square around the first point / the box."""

    def set_image(self, rgb):
        self.shape = rgb.shape[:2]

    def predict(self, point_coords=None, point_labels=None, box=None, multimask_output=False):
        m = np.zeros(self.shape, bool)
        if box is not None:
            x0, y0, x1, y1 = [int(v) for v in box]
        else:
            x, y = [int(v) for v in point_coords[0]]
            x0, y0, x1, y1 = x - 10, y - 10, x + 10, y + 10
        m[max(y0, 0) : y1, max(x0, 0) : x1] = True
        return m[None], np.array([0.9]), None


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = FakePredictor()
    monkeypatch.setattr(ModelRegistry, "get_sam2", lambda self, model, device: fake)
    inp, out = tmp_path / "in", tmp_path / "out"
    (inp / "plotA").mkdir(parents=True)
    out.mkdir()
    for p in (inp / "one.png", inp / "plotA" / "two.png"):
        cv2.imwrite(str(p), np.full((60, 80, 3), 128, np.uint8))
    with TestClient(app) as c:
        c.put("/api/settings", json={"inputDir": str(inp), "outputDir": str(out)})
        c.dirs = (inp, out)
        yield c


def test_health_and_system_boot_without_models(client):
    assert client.get("/api/health").json() == {"ok": True}
    status = client.get("/api/system").json()
    assert "problems" in status and "models" in status and len(status["models"]) == 4


def test_settings_validation(client, tmp_path):
    inp, _ = client.dirs
    assert client.put("/api/settings", json={"inputDir": str(tmp_path / "nope")}).status_code == 400
    assert client.put("/api/settings", json={"outputDir": str(inp)}).status_code == 400  # same as input
    assert client.put("/api/settings", json={"samModel": "huge"}).status_code == 422
    assert client.put("/api/settings", json={"export": {"saveMask": False}}).json()["export"]["saveMask"] is False


def test_fs_browser(client, tmp_path):
    inp, _ = client.dirs
    r = client.get("/api/fs/list", params={"path": str(inp)}).json()
    assert [f["name"] for f in r["folders"]] == ["plotA"] and r["imageCount"] == 1 and r["writable"]
    assert client.post("/api/fs/mkdir", json={"path": str(inp), "name": "new"}).status_code == 200
    assert client.post("/api/fs/mkdir", json={"path": str(inp), "name": "../x"}).status_code == 400
    assert client.get("/api/fs/list", params={"path": str(tmp_path / "ghost")}).status_code == 404


def test_full_flow_objects_save_resume(client):
    inp, out = client.dirs
    lst = client.get("/api/samples").json()
    assert [s["key"] for s in lst["samples"]] == ["one.png", "plotA/two.png"]
    assert lst["firstPendingKey"] == "one.png"

    s = client.post("/api/session/load", json={"sampleKey": "one.png"}).json()
    assert (s["width"], s["height"], s["kind"], s["objects"]) == (80, 60, "rgb", [])

    # point object, then a box object; editing #1 must not touch #2
    r1 = client.post("/api/session/objects", json={"points": [{"x": 20, "y": 20}]}).json()
    r2 = client.post("/api/session/objects", json={"box": {"x0": 50, "y0": 30, "x1": 70, "y1": 50}}).json()
    assert set(r1) == {"object"} and (r1["object"]["id"], r2["object"]["id"]) == (1, 2)  # only the new object comes back
    assert "thumbnailJpegBase64" not in r1["object"]
    assert client.patch("/api/session/objects/2", json={"label": "leaf 2", "shrink": 1}).json() == {"id": 2, "label": "leaf 2", "shrink": 1}
    r = client.put("/api/session/objects/1/prompts",
                   json={"points": [{"x": 30, "y": 30}, {"x": 40, "y": 40, "label": 0}]}).json()
    assert list(r) == ["object"] and r["object"]["points"][1]["label"] == 0
    s = client.get("/api/session").json()  # full snapshot still has both, #2 untouched
    assert [o["label"] for o in s["objects"]] == ["", "leaf 2"]
    assert client.post("/api/session/suggest-borders").json()["shrinks"].keys() == {"1", "2"}
    assert client.post("/api/session/objects/1/reset-mask").json()["object"]["id"] == 1
    assert client.post("/api/session/masks", json={"masks": []}).json() == {"ok": True, "count": 0}
    gone = client.post("/api/session/objects", json={"points": [{"x": 5, "y": 5}]}).json()["object"]["id"]
    assert client.delete(f"/api/session/objects/{gone}").json() == {"deletedId": gone}

    assert client.post("/api/session/objects", json={}).status_code == 400  # needs a prompt
    assert client.post("/api/session/objects", json={"points": [{"x": 1, "y": 1, "label": 0}]}).status_code == 400

    r = client.post("/api/session/save", json={"complete": True}).json()
    assert r["savedCount"] == 2 and r["nextSampleKey"] == "plotA/two.png"
    assert (out / "one" / "object_001.png").exists() and (out / "one" / "leaf 2.png").exists()
    assert (out / "one" / "objects.csv").exists()

    again = client.post("/api/session/save", json={})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "would_overwrite"
    assert client.post("/api/session/save", json={"forceOverwrite": True}).status_code == 200

    counts = client.get("/api/samples").json()["counts"]
    assert counts["Completed"] == 1 and counts["Pending"] == 1

    # stale client targeting the old image is rejected
    client.post("/api/session/load", json={"sampleKey": "plotA/two.png"})
    assert client.post("/api/session/objects", json={"points": [{"x": 5, "y": 5}], "sampleKey": "one.png"}).status_code == 409
    assert client.post("/api/session/skip").json()["nextSampleKey"] is None


def test_engine_missing_returns_503(tmp_path, monkeypatch):
    monkeypatch.setenv("SEGTOOL_HOME", str(tmp_path / "h"))
    import backend.engine as eng

    monkeypatch.setattr(eng, "checkpoint_path", lambda model: None)
    monkeypatch.setattr(ModelRegistry, "get_sam2", lambda self, m, d: (_ for _ in ()).throw(eng.EngineUnavailable("checkpoint_missing", "no model")))
    inp, out = tmp_path / "i", tmp_path / "o"
    inp.mkdir()
    cv2.imwrite(str(inp / "a.png"), np.zeros((20, 20, 3), np.uint8))
    with TestClient(app) as c:
        c.put("/api/settings", json={"inputDir": str(inp), "outputDir": str(out)})
        c.post("/api/session/load", json={"sampleKey": "a.png"})
        r = c.post("/api/session/objects", json={"points": [{"x": 5, "y": 5}]})
        assert r.status_code == 503 and r.json()["code"] == "checkpoint_missing"
        assert c.get("/api/session").json()["objects"] == []


def test_orientation_change_after_open_does_not_corrupt_export(client):
    _, out = client.dirs
    client.post("/api/session/load", json={"sampleKey": "one.png"})  # 80 wide x 60 high
    client.post("/api/session/objects", json={"points": [{"x": 20, "y": 20}]})
    client.put("/api/settings", json={"orientation": {"rotate": 90}})  # user rotates afterwards
    assert client.post("/api/session/save", json={}).status_code == 200
    png = cv2.imread(str(out / "one" / "object_001.png"), cv2.IMREAD_UNCHANGED)
    assert png.shape[:2] == (20, 20) and (png[:, :, 3] == 255).all()  # still the original square


def _mask_of(obj):
    import base64
    return cv2.imdecode(np.frombuffer(base64.b64decode(obj["maskPngBase64"]), np.uint8), 0)


def test_rotating_one_image_turns_objects_and_is_remembered(client):
    inp, out = client.dirs
    client.post("/api/session/load", json={"sampleKey": "one.png"})  # 80 wide x 60 high
    box = {"x0": 30, "y0": 10, "x1": 70, "y1": 30}  # 40 wide x 20 high
    client.post("/api/session/objects", json={"box": box})
    client.post("/api/session/objects", json={"points": [{"x": 20, "y": 45}]})
    s = client.post("/api/session/rotate", json={"degrees": 90}).json()
    assert (s["width"], s["height"], s["rotation"]) == (60, 80, 90)
    assert (s["nativeWidth"], s["nativeHeight"]) == (60, 80)
    m = _mask_of(s["objects"][0])
    ys, xs = np.where(m > 0)
    # clockwise: x' = H-1-y, y' = x  ->  the 40x20 box becomes 20 wide x 40 high
    assert (xs.min(), xs.max(), ys.min(), ys.max()) == (30, 49, 30, 69)
    assert s["objects"][0]["box"] == {"x0": 30, "y0": 30, "x1": 50, "y1": 70}
    assert s["objects"][1]["points"][0] == {"x": 14, "y": 20, "label": 1}  # (20,45) -> (59-45, 20)

    # the rotated object can still be refined (SAM sees the rotated picture)
    r = client.put("/api/session/objects/2/prompts", json={"points": [{"x": 14, "y": 20}, {"x": 16, "y": 22}]})
    assert r.status_code == 200

    # remembered: reopening the image keeps the rotation; the progress file keeps it next to the status
    assert client.post("/api/session/load", json={"sampleKey": "one.png"}).json()["rotation"] == 90
    client.post("/api/session/objects", json={"box": box_rot(box)})
    assert client.post("/api/session/save", json={"complete": True}).status_code == 200
    import json as _json
    entry = _json.loads((out / "segmentation_progress.json").read_text())["one.png"]
    assert entry["rotate"] == 90 and entry["status"] == "Completed"
    png = cv2.imread(str(out / "one" / "object_001.png"), cv2.IMREAD_UNCHANGED)
    assert png.shape[:2] == (40, 20)  # exported upright the way it was rotated on screen

    # other images are unaffected; rotating back to 0 clears the entry's rotation
    assert client.post("/api/session/load", json={"sampleKey": "plotA/two.png"}).json()["rotation"] == 0
    client.post("/api/session/load", json={"sampleKey": "one.png"})
    client.post("/api/session/rotate", json={"degrees": 270})
    entry = _json.loads((out / "segmentation_progress.json").read_text())["one.png"]
    assert "rotate" not in entry and entry["status"] == "Completed"


def box_rot(box):
    """The same 40x20 region as a box on the 90-degree-rotated 60x80 image."""
    return {"x0": 30, "y0": 30, "x1": 50, "y1": 70}


def test_rotate_rejects_bad_angles_and_needs_an_open_image(client):
    assert client.post("/api/session/rotate", json={"degrees": 90}).status_code == 400
    client.post("/api/session/load", json={"sampleKey": "one.png"})
    assert client.post("/api/session/rotate", json={"degrees": 45}).status_code == 422
