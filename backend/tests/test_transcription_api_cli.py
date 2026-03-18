"""Tests for offline transcription API and CLI."""

from __future__ import annotations

import io
import math
import sys
import types
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from music21 import converter

from backend.cli import main as cli_main
from backend.models.transcription import PitchFrame
from backend.transcription_service import TranscriptionError, TranscriptionResult, transcribe_audio_file


def _install_sounddevice_stub() -> None:
    stub = types.ModuleType("sounddevice")

    class PortAudioError(Exception):
        pass

    class CallbackFlags:
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

    stub.PortAudioError = PortAudioError
    stub.CallbackFlags = CallbackFlags
    stub.InputStream = InputStream
    def query_hostapis():
        return []

    def query_devices(kind=None):
        if kind == "input":
            raise PortAudioError("No input devices")
        return []

    stub.query_hostapis = query_hostapis
    stub.query_devices = query_devices
    sys.modules["sounddevice"] = stub


def _install_torch_stub() -> None:
    stub = types.ModuleType("torch")

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    stub.cuda = _Cuda()
    sys.modules["torch"] = stub


def _write_wav(path: Path, *, duration_seconds: float = 2.0, frequency_hz: float = 440.0) -> None:
    sample_rate = 22050
    t = np.linspace(0.0, duration_seconds, int(sample_rate * duration_seconds), endpoint=False)
    samples = (0.3 * np.sin(2.0 * math.pi * frequency_hz * t)).astype(np.float32)
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


@pytest.fixture(scope="module")
def client() -> TestClient:
    try:
        import sounddevice  # noqa: F401
    except OSError:
        _install_sounddevice_stub()
    except ModuleNotFoundError:
        _install_sounddevice_stub()

    try:
        import torch  # noqa: F401
    except ModuleNotFoundError:
        _install_torch_stub()

    from backend.main import app

    return TestClient(app)


def test_transcribe_audio_file_returns_valid_musicxml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio_path = tmp_path / "input.wav"
    _write_wav(audio_path)

    def fake_infer(_window, capture_time_ms: float):
        midi = 60.0 if capture_time_ms < 1000.0 else 64.0
        return PitchFrame(time_ms=capture_time_ms, midi=midi, confidence=0.95)

    monkeypatch.setattr("backend.transcription_service._infer_pyin", fake_infer)

    result = transcribe_audio_file(audio_path)

    assert result.note_count == 2
    assert "<score-partwise" in result.musicxml
    parsed = converter.parseData(result.musicxml)
    notes = [note.nameWithOctave for note in parsed.parts[0].recurse().notes]
    assert notes[:2] == ["C4", "E4"]


def test_transcribe_audio_endpoint_returns_musicxml(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: TranscriptionResult(
            musicxml="<?xml version='1.0' encoding='utf-8'?><score-partwise version='4.0'></score-partwise>",
            tempo_bpm=120.0,
            key_signature=None,
            note_count=1,
        ),
    )

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/vnd.recordare.musicxml+xml")
    assert "score-partwise" in response.text


def test_transcribe_audio_endpoint_rejects_unsupported_type(client: TestClient) -> None:
    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.mp3", io.BytesIO(b"not-wav"), "audio/mpeg")},
    )

    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


def test_cli_transcribe_writes_musicxml_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    audio_path = tmp_path / "input.wav"
    output_path = tmp_path / "output.musicxml"
    _write_wav(audio_path)

    monkeypatch.setattr(
        "backend.cli.transcribe_audio_file",
        lambda _path: TranscriptionResult(
            musicxml="<?xml version='1.0' encoding='utf-8'?><score-partwise version='4.0'></score-partwise>",
            tempo_bpm=120.0,
            key_signature=None,
            note_count=1,
        ),
    )

    exit_code = cli_main(["transcribe", str(audio_path), "--output", str(output_path)])

    assert exit_code == 0
    assert output_path.exists()
    assert "score-partwise" in output_path.read_text(encoding="utf-8")
    assert str(output_path) in capsys.readouterr().out


def test_cli_transcribe_reports_invalid_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "bad.wav"
    audio_path.write_bytes(b"not a wav")

    monkeypatch.setattr(
        "backend.cli.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(TranscriptionError("boom")),
    )

    exit_code = cli_main(["transcribe", str(audio_path)])

    assert exit_code == 1
    assert "boom" in capsys.readouterr().err
