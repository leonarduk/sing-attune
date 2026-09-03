"""Integration tests for the /score API endpoint contract and error handling."""

from __future__ import annotations

import io
import sys
import types
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from music21 import meter, note, stream

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
    assert "parse" in response.json()["detail"].lower()


def _build_malformed_tempo_mark_mxl(tmp_path: Path) -> bytes:
    """
    Build a .mxl where music21's own parser succeeds but the module's raw-XML
    tempo-mark fallback (_get_xml_content + ET.fromstring) hits a malformed
    entry.

    This exploits a real divergence between the two archive-member "which
    .xml is the real one" heuristics: _get_xml_content trusts
    META-INF/container.xml's declared rootfile when present (issue #528),
    while music21's own ArchiveManager never actually reads container.xml —
    despite a comment in its source claiming it does — and always falls back
    to picking the first non-META-INF entry with a recognised MusicXML
    suffix, in archive order. So a container.xml that (wrongly) declares the
    malformed entry as the rootfile, while the good entry still sorts first
    by the suffix heuristic, makes music21 parse the good entry successfully
    while our own fallback reads the malformed one it was pointed at. The
    score itself has no tempo/metronome mark, so parsing it falls through to
    the raw-XML fallback and lands on the malformed member. See issues #429
    and #538.
    """
    score = stream.Score()
    part = stream.Part()
    part.partName = "Test Part"
    part.append(meter.TimeSignature("4/4"))
    measure = stream.Measure(number=1)
    measure.append(note.Note("C4", quarterLength=4))
    part.append(measure)
    score.append(part)

    good_xml_path = tmp_path / "good.musicxml"
    score.write("musicxml", fp=good_xml_path)
    good_xml_text = good_xml_path.read_text(encoding="utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<container><rootfiles><rootfile full-path="malformed.xml"/></rootfiles></container>',
        )
        # music21's ArchiveManager ignores container.xml and uses its own
        # suffix heuristic instead, so it parses this entry: the first
        # non-META-INF member with a recognised MusicXML suffix in archive order.
        zf.writestr("good.musicxml", good_xml_text)
        # _get_xml_content trusts container.xml's declared rootfile above, so
        # it reads this deliberately-broken sibling for the tempo-mark fallback
        # scan instead of the good entry music21 just parsed.
        zf.writestr("malformed.xml", '<score-partwise><part id="P1"><note><unclosed></measure></part>')
    return buf.getvalue()


def test_score_endpoint_handles_malformed_tempo_mark_fallback_xml(client: TestClient, tmp_path: Path) -> None:
    mxl_bytes = _build_malformed_tempo_mark_mxl(tmp_path)

    response = client.post(
        "/score",
        files={"file": ("malformed_tempo.mxl", io.BytesIO(mxl_bytes), "application/vnd.recordare.musicxml")},
    )

    assert response.status_code == 422
    assert "tempo" in response.json()["detail"].lower()
