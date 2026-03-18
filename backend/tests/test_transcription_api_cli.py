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
from backend.transcription_service import (
    HOP_SIZE,
    SAMPLE_RATE,
    TranscriptionError,
    TranscriptionResult,
    _build_quantized_spans,
    _frames_to_note_events,
    _load_wav_mono,
    _midi_to_pitch_name,
    transcribe_audio_file,
)


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


def test_transcribe_audio_file_rejects_missing_or_unsupported_input(tmp_path: Path) -> None:
    missing_path = tmp_path / "missing.wav"
    with pytest.raises(FileNotFoundError, match="Audio file not found"):
        transcribe_audio_file(missing_path)

    invalid_path = tmp_path / "input.mp3"
    invalid_path.write_bytes(b"not-a-wav")
    with pytest.raises(TranscriptionError, match="Unsupported audio file type"):
        transcribe_audio_file(invalid_path)


def test_transcribe_audio_file_rejects_short_audio(tmp_path: Path) -> None:
    audio_path = tmp_path / "short.wav"
    _write_wav(audio_path, duration_seconds=0.01)

    with pytest.raises(TranscriptionError, match="too short to transcribe"):
        transcribe_audio_file(audio_path)


def test_transcribe_audio_file_rejects_when_no_notes_are_detected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio_path = tmp_path / "flat.wav"
    _write_wav(audio_path)
    monkeypatch.setattr("backend.transcription_service._infer_pyin", lambda *_args, **_kwargs: None)

    with pytest.raises(TranscriptionError, match="No pitched notes were detected"):
        transcribe_audio_file(audio_path)


def test_load_wav_mono_rejects_invalid_or_empty_wav(tmp_path: Path) -> None:
    invalid_path = tmp_path / "broken.wav"
    invalid_path.write_bytes(b"not-a-real-wav")

    with pytest.raises(TranscriptionError, match="Invalid WAV file"):
        _load_wav_mono(invalid_path)

    empty_path = tmp_path / "empty.wav"
    with wave.open(str(empty_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(b"")

    with pytest.raises(TranscriptionError, match="Audio file is empty"):
        _load_wav_mono(empty_path)


def test_load_wav_mono_converts_stereo_and_resamples(tmp_path: Path) -> None:
    sample_rate = 11025
    duration_seconds = 0.25
    t = np.linspace(0.0, duration_seconds, int(sample_rate * duration_seconds), endpoint=False)
    left = (0.7 * np.sin(2.0 * math.pi * 220.0 * t)).astype(np.float32)
    right = (0.3 * np.sin(2.0 * math.pi * 330.0 * t)).astype(np.float32)
    stereo = np.column_stack((left, right))
    pcm = np.clip(stereo * 32767.0, -32768, 32767).astype("<i2")

    audio_path = tmp_path / "stereo.wav"
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())

    samples = _load_wav_mono(audio_path)

    assert samples.dtype == np.float32
    assert len(samples) > pcm.shape[0]
    assert np.max(np.abs(samples)) <= 1.0


def test_load_wav_mono_supports_24bit_pcm(tmp_path: Path) -> None:
    audio_path = tmp_path / "sample24.wav"
    sample_values = [0, (1 << 22), -(1 << 22)]

    def to_pcm24le(value: int) -> bytes:
        if value < 0:
            value += 1 << 24
        return bytes((value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF))

    raw_frames = b"".join(to_pcm24le(value) for value in sample_values)
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(3)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(raw_frames)

    samples = _load_wav_mono(audio_path)

    assert samples == pytest.approx(np.array([0.0, 0.5, -0.5], dtype=np.float32), abs=1e-6)


def test_frames_to_note_events_splits_on_pitch_jumps_and_discards_short_segments() -> None:
    hop_seconds = HOP_SIZE / SAMPLE_RATE
    frames = [
        PitchFrame(time_ms=1000.0, midi=60.0, confidence=0.9),
        PitchFrame(time_ms=(1000.0 + (hop_seconds * 1000.0)), midi=60.1, confidence=0.8),
        PitchFrame(time_ms=(1000.0 + (2 * hop_seconds * 1000.0)), midi=64.0, confidence=0.7),
        PitchFrame(time_ms=(1000.0 + (3 * hop_seconds * 1000.0)), midi=64.1, confidence=0.7),
        PitchFrame(time_ms=(1000.0 + (4 * hop_seconds * 1000.0)), midi=67.0, confidence=0.6),
    ]

    events = _frames_to_note_events(frames, audio_duration_seconds=2.0)

    assert len(events) == 2
    assert events[0].start_time == pytest.approx(1.0)
    assert events[0].end_time > events[0].start_time
    assert events[1].start_time == pytest.approx(frames[2].time_ms / 1000.0)
    assert events[1].end_time > events[1].start_time


def test_build_quantized_spans_and_pitch_name_cover_rest_and_validation() -> None:
    rest_events = _build_quantized_spans(0.0, 0.0, 0.0, seconds_per_beat=0.5, is_rest=True)
    assert rest_events == []

    note_events = _build_quantized_spans(1.5, 2.0, 2.0, seconds_per_beat=0.5, is_rest=False, pitch_name="A4", confidence=0.75)

    assert [event.event_type for event in note_events] == ["note", "note"]
    assert sum(event.duration_beats for event in note_events) == pytest.approx(1.5)
    assert all(event.pitch == "A4" for event in note_events)
    assert all(event.confidence == pytest.approx(0.75) for event in note_events)
    assert _midi_to_pitch_name(440.0) == "A4"

    with pytest.raises(TranscriptionError, match="pitch must be positive"):
        _midi_to_pitch_name(0.0)

    with pytest.raises(TranscriptionError, match="pitch must be positive"):
        _midi_to_pitch_name(math.inf)


def test_transcribe_audio_endpoint_maps_service_errors(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(TranscriptionError("bad wav")),
    )

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "bad wav"


def test_transcribe_audio_endpoint_maps_missing_file_errors(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(FileNotFoundError("gone")),
    )

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "gone"


def test_cli_transcribe_uses_default_output_suffix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    audio_path = tmp_path / "input.wav"
    _write_wav(audio_path)

    monkeypatch.setattr(
        "backend.cli.transcribe_audio_file",
        lambda _path: TranscriptionResult(
            musicxml="<score-partwise version='4.0'></score-partwise>",
            tempo_bpm=120.0,
            key_signature=None,
            note_count=1,
        ),
    )

    exit_code = cli_main(["transcribe", str(audio_path)])
    output_path = audio_path.with_suffix(".musicxml")

    assert exit_code == 0
    assert output_path.exists()
    assert str(output_path) in capsys.readouterr().out
