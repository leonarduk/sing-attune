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
from backend.models.transcription import NoteEvent, PitchFrame
from backend.music import quantize_note_events
from backend.transcription_service import (
    HOP_SIZE,
    SAMPLE_RATE,
    UNSUPPORTED_AUDIO_ERROR_CATEGORY,
    TranscriptionError,
    TranscriptionErrorType,
    TranscriptionResult,
    _frames_to_note_events,
    _load_audio_mono,
    _load_wav_mono,
    _midi_to_pitch_name,
    _pcm_bytes_to_float32,
    classify_audio_load_error,
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
    assert "Unsupported audio file type" in response.json()["detail"]


def test_transcribe_audio_endpoint_maps_decode_errors_to_bad_request(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(
            TranscriptionError("Invalid WAV file: broken data", category=UNSUPPORTED_AUDIO_ERROR_CATEGORY)
        ),
    )

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid WAV file: broken data"


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


def test_classify_audio_load_error_distinguishes_decode_from_operational_errors() -> None:
    decode_error = RuntimeError("decoder failed: unknown format")
    operational_error = RuntimeError("I/O error while reading stream")

    assert classify_audio_load_error(decode_error) is TranscriptionErrorType.UNSUPPORTED_AUDIO_TYPE
    assert classify_audio_load_error(operational_error) is TranscriptionErrorType.GENERIC


def test_transcribe_audio_file_preserves_non_format_load_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio_path = tmp_path / "input.mp3"
    audio_path.write_bytes(b"fake")
    monkeypatch.setattr(
        "backend.transcription_service.librosa.load",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk read failure")),
    )

    with pytest.raises(TranscriptionError, match="Failed to load audio file") as exc_info:
        transcribe_audio_file(audio_path)

    assert exc_info.value.error_type is TranscriptionErrorType.GENERIC


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


@pytest.mark.parametrize(
    ("sample_width", "raw_frames", "expected"),
    [
        (1, bytes((0, 128, 255)), np.array([-1.0, 0.0, 127.0 / 128.0], dtype=np.float32)),
        (2, np.array([-32768, 0, 32767], dtype="<i2").tobytes(), np.array([-1.0, 0.0, 32767.0 / 32768.0], dtype=np.float32)),
        (3, bytes((0, 0, 128, 0, 0, 0, 255, 255, 127)), np.array([-1.0, 0.0, 8388607.0 / 8388608.0], dtype=np.float32)),
        (4, np.array([-(1 << 31), 0, (1 << 31) - 1], dtype="<i4").tobytes(), np.array([-1.0, 0.0, ((2**31 - 1) / float(2**31))], dtype=np.float32)),
    ],
)
def test_pcm_bytes_to_float32_supports_all_sample_widths(
    sample_width: int,
    raw_frames: bytes,
    expected: np.ndarray,
) -> None:
    samples = _pcm_bytes_to_float32(raw_frames, sample_width=sample_width)

    assert samples.dtype == np.float32
    assert samples == pytest.approx(expected, abs=1e-6)


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


A4_HZ = 440.0
B4_HZ = 493.88
C5_HZ = 523.25
D5_HZ = 587.33


def test_quantize_note_events_covers_canonical_rest_and_tie_behavior() -> None:
    """Validate canonical quantizer behavior for rests, ties, gaps, and dropped tiny events."""

    assert quantize_note_events([], tempo_bpm=120.0, time_signature="4/4") == []

    quantized_events = quantize_note_events(
        [
            NoteEvent(start_time=1.0, end_time=1.75, pitch=A4_HZ, confidence=0.75),
            NoteEvent(start_time=2.0, end_time=2.5, pitch=B4_HZ, confidence=0.6),
            NoteEvent(start_time=2.75, end_time=3.375, pitch=C5_HZ, confidence=0.9),
            NoteEvent(start_time=4.0, end_time=4.0001, pitch=D5_HZ, confidence=0.2),
        ],
        tempo_bpm=120.0,
        time_signature="4/4",
    )

    # The quantizer emits explicit rests for every beat gap between quantized note spans,
    # so a note that lands on beat 2 is preceded by a two-beat rest from the measure start.
    assert [event.event_type for event in quantized_events] == [
        "rest",
        "note",
        "rest",
        "note",
        "rest",
        "note",
        "note",
    ]
    assert [event.duration_beats for event in quantized_events] == pytest.approx(
        [2.0, 1.5, 0.5, 1.0, 0.5, 1.0, 0.25]
    )
    assert [event.pitch for event in quantized_events] == [None, "A4", None, "B4", None, "C5", "C5"]
    assert [event.confidence for event in quantized_events] == pytest.approx(
        [1.0, 0.75, 1.0, 0.6, 1.0, 0.9, 0.9]
    )
    assert [event.tie_start for event in quantized_events] == [False, False, False, False, False, True, False]
    assert [event.tie_stop for event in quantized_events] == [False, False, False, False, False, False, True]


def test_quantize_note_events_handles_off_grid_alignment_and_sequential_notes() -> None:
    quantized_events = quantize_note_events(
        [
            NoteEvent(start_time=0.12, end_time=0.66, pitch=A4_HZ, confidence=0.8),
            NoteEvent(start_time=0.88, end_time=1.42, pitch=B4_HZ, confidence=0.65),
            NoteEvent(start_time=1.42, end_time=1.89, pitch=C5_HZ, confidence=0.55),
        ],
        tempo_bpm=120.0,
        time_signature="4/4",
    )

    assert [event.event_type for event in quantized_events] == ["rest", "note", "rest", "note", "note"]
    assert [event.duration_beats for event in quantized_events] == pytest.approx([0.25, 1.0, 0.5, 1.0, 1.0])
    assert [event.pitch for event in quantized_events] == [None, "A4", None, "B4", "C5"]
    assert [event.confidence for event in quantized_events] == pytest.approx([1.0, 0.8, 1.0, 0.65, 0.55])
    assert all(not event.tie_start for event in quantized_events)
    assert all(not event.tie_stop for event in quantized_events)


def test_midi_to_pitch_name_validates_frequency_inputs() -> None:
    assert _midi_to_pitch_name(A4_HZ) == "A4"

    with pytest.raises(TranscriptionError, match="pitch must be positive"):
        _midi_to_pitch_name(-1.0)

    with pytest.raises(TranscriptionError, match="pitch must be positive"):
        _midi_to_pitch_name(0.0)

    with pytest.raises(TranscriptionError, match="pitch must be finite"):
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


def test_transcribe_audio_endpoint_maps_unsupported_audio_to_bad_request(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(
            TranscriptionError(
                "Unsupported audio file type '.mp3'. Upload a .wav or .mp3 audio file.",
                error_type=TranscriptionErrorType.UNSUPPORTED_AUDIO_TYPE,
            )
        ),
    )

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.mp3", io.BytesIO(b"not-audio"), "audio/mpeg")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported file type '.mp3'. Upload a .wav or .mp3 audio file."
def test_transcribe_audio_endpoint_logs_request_and_success(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: TranscriptionResult(
            musicxml="<?xml version='1.0' encoding='utf-8'?><score-partwise version='4.0'></score-partwise>",
            tempo_bpm=120.0,
            key_signature="C",
            note_count=2,
        ),
    )
    caplog.set_level("INFO")

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 200
    assert any(record.levelname == "INFO" and "Transcription request received" in record.message for record in caplog.records)
    assert any(record.levelname == "INFO" and "Transcription success" in record.message for record in caplog.records)


def test_transcribe_audio_endpoint_logs_failures(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        "backend.main.transcribe_audio_file",
        lambda _path: (_ for _ in ()).throw(TranscriptionError("pipeline exploded")),
    )
    caplog.set_level("INFO")

    response = client.post(
        "/transcribe/audio",
        files={"file": ("take.wav", io.BytesIO(b"RIFF....WAVE"), "audio/wav")},
    )

    assert response.status_code == 422
    assert any(record.levelname == "ERROR" and "Transcription failed" in record.message for record in caplog.records)


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


def test_load_audio_mono_normalizes_loader_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "bad.mp3"
    path.write_bytes(b"not-an-mp3")
    monkeypatch.setattr("backend.transcription_service.librosa.load", lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("decode fail")))

    with pytest.raises(TranscriptionError, match="Unsupported audio file type") as exc_info:
        _load_audio_mono(path)

    assert exc_info.value.category == UNSUPPORTED_AUDIO_ERROR_CATEGORY


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
