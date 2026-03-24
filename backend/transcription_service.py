"""Offline audio transcription service for MusicXML export."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import wave

import librosa
import numpy as np

from backend.audio.music_analysis import estimate_key, estimate_tempo
from backend.audio.pitch import _infer_pyin, midi_to_hz
from backend.models.transcription import NoteEvent, PitchFrame
from backend.music import (
    ScoreMetadata,
    quantize_note_events,
    score_model_from_quantized_events,
    score_model_to_musicxml_string,
)
from backend.music.quantization import _midi_to_pitch_name as _quantization_pitch_name
from backend.music.notation_policy import V1_NOTATION_POLICY

SUPPORTED_AUDIO_SUFFIXES = {".wav", ".wave", ".mp3"}
SAMPLE_RATE = 22050
WINDOW_SIZE = 2048
HOP_SIZE = WINDOW_SIZE // 2
DEFAULT_TEMPO_BPM = 120.0
MIN_NOTE_DURATION_SECONDS = 0.08
MAX_MIDI_JUMP_FOR_SAME_NOTE = 0.75


class TranscriptionError(ValueError):
    """Raised when an audio file cannot be transcribed."""


@dataclass(frozen=True)
class TranscriptionResult:
    musicxml: str
    tempo_bpm: float
    key_signature: str | None
    note_count: int


def transcribe_audio_file(path: str | Path) -> TranscriptionResult:
    audio_path = Path(path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    if audio_path.suffix.lower() not in SUPPORTED_AUDIO_SUFFIXES:
        raise TranscriptionError(
            f"Unsupported audio file type '{audio_path.suffix}'. Upload a .wav or .mp3 audio file."
        )

    samples = _load_audio_mono(audio_path)
    if len(samples) < WINDOW_SIZE:
        raise TranscriptionError(
            "Audio file is too short to transcribe. Provide at least 2048 samples of audio."
        )

    frames = _detect_pitch_frames(samples)
    note_events = _frames_to_note_events(frames, len(samples) / SAMPLE_RATE)
    if not note_events:
        raise TranscriptionError(
            "No pitched notes were detected. Check that the audio contains a clear monophonic vocal line."
        )

    tempo_bpm = estimate_tempo(note_events) or DEFAULT_TEMPO_BPM
    key_signature = estimate_key(note_events)
    try:
        quantized_events = quantize_note_events(
            note_events,
            tempo_bpm=tempo_bpm,
            time_signature=V1_NOTATION_POLICY.default_time_signature,
            notation_policy=V1_NOTATION_POLICY,
        )
    except ValueError as exc:
        raise TranscriptionError(str(exc)) from exc
    score_model = score_model_from_quantized_events(
        quantized_events,
        metadata=ScoreMetadata(
            tempo_bpm=tempo_bpm,
            key_signature=key_signature,
            time_signature=V1_NOTATION_POLICY.default_time_signature,
        ),
    )
    return TranscriptionResult(
        musicxml=score_model_to_musicxml_string(score_model),
        tempo_bpm=tempo_bpm,
        key_signature=key_signature,
        note_count=len(note_events),
    )


def _load_audio_mono(path: Path) -> np.ndarray:
    """Load any supported audio file (WAV or MP3) as mono float32 at SAMPLE_RATE."""
    suffix = path.suffix.lower()
    if suffix in {".wav", ".wave"}:
        return _load_wav_mono(path)
    # For MP3 and other formats supported by librosa/soundfile
    try:
        samples, _ = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    except Exception as exc:
        raise TranscriptionError(
            f"Unsupported audio file type '{path.suffix.lower()}'. Upload a .wav or .mp3 audio file."
        ) from exc
    return np.clip(samples.astype(np.float32, copy=False), -1.0, 1.0)


def _load_wav_mono(path: Path) -> np.ndarray:
    try:
        with wave.open(str(path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            raw_frames = wav_file.readframes(frame_count)
    except (wave.Error, EOFError) as exc:
        raise TranscriptionError(f"Invalid WAV file: {exc}") from exc

    if channels <= 0:
        raise TranscriptionError("Invalid WAV file: channel count must be positive")
    if sample_width not in {1, 2, 3, 4}:
        raise TranscriptionError(f"Unsupported WAV sample width: {sample_width * 8} bits")

    samples = _pcm_bytes_to_float32(raw_frames, sample_width=sample_width)
    if len(samples) == 0:
        raise TranscriptionError("Audio file is empty")

    if channels > 1:
        usable = len(samples) - (len(samples) % channels)
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)

    if sample_rate != SAMPLE_RATE:
        samples = librosa.resample(samples, orig_sr=sample_rate, target_sr=SAMPLE_RATE)

    return np.clip(samples.astype(np.float32, copy=False), -1.0, 1.0)


def _pcm_bytes_to_float32(raw_frames: bytes, *, sample_width: int) -> np.ndarray:
    if sample_width == 3:
        return _pcm24le_to_float32(raw_frames)
    if sample_width == 1:
        return (np.frombuffer(raw_frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if sample_width == 2:
        return np.frombuffer(raw_frames, dtype="<i2").astype(np.float32) / 32768.0
    if sample_width == 4:
        return np.frombuffer(raw_frames, dtype="<i4").astype(np.float32) / 2147483648.0
    raise TranscriptionError(f"Unsupported WAV sample width: {sample_width * 8} bits")


def _pcm24le_to_float32(raw_frames: bytes) -> np.ndarray:
    data = np.frombuffer(raw_frames, dtype=np.uint8)
    usable = len(data) - (len(data) % 3)
    if usable == 0:
        return np.zeros(0, dtype=np.float32)
    triples = data[:usable].reshape(-1, 3)
    values = (
        triples[:, 0].astype(np.int32)
        | (triples[:, 1].astype(np.int32) << 8)
        | (triples[:, 2].astype(np.int32) << 16)
    )
    sign_mask = 1 << 23
    values = (values ^ sign_mask) - sign_mask
    return values.astype(np.float32) / float(1 << 23)


def _detect_pitch_frames(samples: np.ndarray) -> list[PitchFrame]:
    frames: list[PitchFrame] = []
    total = len(samples)
    for start in range(0, total - WINDOW_SIZE + 1, HOP_SIZE):
        window = samples[start : start + WINDOW_SIZE]
        capture_time_ms = ((start + (WINDOW_SIZE / 2)) / SAMPLE_RATE) * 1000.0
        frame = _infer_pyin(window, capture_time_ms)
        if frame is not None:
            frames.append(frame)
    return frames


def _frames_to_note_events(frames: list[PitchFrame], audio_duration_seconds: float) -> list[NoteEvent]:
    if not frames:
        return []

    events: list[NoteEvent] = []
    current_frames: list[PitchFrame] = [frames[0]]
    current_start = frames[0].time_ms / 1000.0
    previous_time = current_start

    for frame in frames[1:]:
        frame_time = frame.time_ms / 1000.0
        gap_seconds = frame_time - previous_time
        midi_jump = abs(frame.midi - current_frames[-1].midi)
        if gap_seconds > ((HOP_SIZE / SAMPLE_RATE) * 1.5) or midi_jump > MAX_MIDI_JUMP_FOR_SAME_NOTE:
            _append_note_event(events, current_frames, current_start, previous_time + (HOP_SIZE / SAMPLE_RATE))
            current_frames = [frame]
            current_start = frame_time
        else:
            current_frames.append(frame)
        previous_time = frame_time

    _append_note_event(
        events,
        current_frames,
        current_start,
        min(audio_duration_seconds, previous_time + (HOP_SIZE / SAMPLE_RATE)),
    )
    return events


def _append_note_event(
    events: list[NoteEvent],
    frames: list[PitchFrame],
    start_time: float,
    end_time: float,
) -> None:
    duration = end_time - start_time
    if duration < MIN_NOTE_DURATION_SECONDS:
        return
    midi_values = np.array([frame.midi for frame in frames], dtype=np.float32)
    confidences = np.array([frame.confidence for frame in frames], dtype=np.float32)
    average_midi = float(np.median(midi_values))
    average_confidence = float(np.mean(confidences)) if len(confidences) else 0.0
    events.append(
        NoteEvent(
            start_time=start_time,
            end_time=end_time,
            pitch=midi_to_hz(average_midi),
            confidence=average_confidence,
        )
    )

def _midi_to_pitch_name(pitch_hz: float) -> str:
    try:
        return _quantization_pitch_name(pitch_hz)
    except ValueError as exc:
        raise TranscriptionError(str(exc)) from exc
