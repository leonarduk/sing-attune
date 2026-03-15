"""Integration tests for the /score API endpoint contract and error handling."""

from __future__ import annotations

import io
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.score.model import ScoreModel

REPO_ROOT = Path(__file__).resolve().parents[2]
HOMEWARD_BOUND_FIXTURE = REPO_ROOT / "musescore" / "homeward_bound.mxl"


def _install_sounddevice_stub() -> None:
    stub = types.ModuleType("sounddevice")

    class PortAudioError(Exception):
        pass

    class CallbackFlags:  # pragma: no cover - typing placeholder only
        pass

    class InputStream:
        def __init__(self, *args, **kwargs):
            self.active = False

        def start(self) -> None:
            self.active = True

        def stop(self) -> None:
            self.active = False

        def close(self) -> None:
            self.active = False

    def query_hostapis() -> list[dict[str, str]]:
        return []

    def query_devices(kind: str | None = None):
        if kind == "input":
            raise PortAudioError("No input devices")
        return []

    stub.PortAudioError = PortAudioError
    stub.CallbackFlags = CallbackFlags
    stub.InputStream = InputStream
    stub.query_hostapis = query_hostapis
    stub.query_devices = query_devices
    sys.modules["sounddevice"] = stub


def _install_torch_stub() -> None:
    stub = types.ModuleType("torch")

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    def device(name: str) -> str:
        return name

    class _NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    stub.cuda = _Cuda()
    stub.device = device
    stub.no_grad = lambda: _NoGrad()
    stub.from_numpy = lambda arr: arr
    sys.modules["torch"] = stub


@pytest.fixture(scope="module")
def client() -> TestClient:
    try:
        import sounddevice  # noqa: F401
    except OSError:
        _install_sounddevice_stub()

    try:
        import torch  # noqa: F401
    except ModuleNotFoundError:
        _install_torch_stub()

    from backend.main import app

    return TestClient(app)


def test_score_endpoint_happy_path_contract(client: TestClient) -> None:
    assert HOMEWARD_BOUND_FIXTURE.exists(), f"Fixture missing: {HOMEWARD_BOUND_FIXTURE}"

    with HOMEWARD_BOUND_FIXTURE.open("rb") as fixture:
        response = client.post(
            "/score",
            files={"file": ("homeward_bound.mxl", fixture, "application/vnd.recordare.musicxml")},
        )

    assert response.status_code == 200
    payload = response.json()

    assert set(payload.keys()) == {
        "title",
        "parts",
        "notes",
        "tempo_marks",
        "time_signatures",
        "total_beats",
    }

    score = ScoreModel.model_validate(payload)
    assert score.title
    assert score.parts
    assert score.notes
    assert score.time_signatures
    assert score.total_beats > 0
    assert score.tempo_marks[0].bpm == pytest.approx(72.0, abs=1.0)


def test_score_endpoint_rejects_unsupported_file_suffix(client: TestClient) -> None:
    response = client.post(
        "/score",
        files={"file": ("score.txt", io.BytesIO(b"not-musicxml"), "text/plain")},
    )

    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


def test_score_endpoint_requires_file(client: TestClient) -> None:
    response = client.post("/score")

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "file"]


def test_score_endpoint_handles_corrupted_xml(client: TestClient) -> None:
    response = client.post(
        "/score",
        files={"file": ("broken.xml", io.BytesIO(b"<score-partwise><broken"), "application/xml")},
    )

    assert response.status_code == 422
    assert response.status_code != 200
    assert "parse" in response.json()["detail"].lower()
