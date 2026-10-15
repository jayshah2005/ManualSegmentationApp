import importlib.util
import socket
from pathlib import Path

spec = importlib.util.spec_from_file_location("run_app", Path(__file__).resolve().parents[1] / "scripts" / "run_app.py")
run_app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_app)


def test_pick_port_skips_busy_ports():
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]
        assert not run_app.port_is_free("127.0.0.1", taken)
        assert run_app.pick_port("127.0.0.1", taken) > taken


def test_restart_code_matches_the_api():
    from backend.api.setup import RESTART_EXIT_CODE

    assert run_app.RESTART_EXIT_CODE == RESTART_EXIT_CODE == 75
