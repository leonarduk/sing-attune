"""Offline pitch extraction for transcription."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from backend.audio.pitch import hz_to_midi
from backend.models.transcription import PitchFrame

DEFAULT_FMIN_HZ = 65.0
DEFAULT_FMAX_HZ = 2093.0
DEFAULT_FRAME_LENGTH = 2048
DEFAULT_HOP_LENGTH = 256
DEFAULT_CONFIDENCE_THRESHOLD = 0.6


@dataclass(frozen=True)
class PitchTrackConfig:
    """Configuration for offline pitch extraction."""

    sample_rate: int
    frame_length: int = DEFAULT_FRAME_LENGTH
    hop_length: int = DEFAULT_HOP_LENGTH
    fmin_hz: float = DEFAULT_FMIN_HZ
    fmax_hz: float = DEFAULT_FMAX_HZ
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD


def _closest_octave(midi: float, reference: float) -> float:
    """Shift ``midi`` by octaves to be nearest to ``reference``."""
    if reference <= 0.0 or midi <= 0.0:
        return midi

    best = midi
    best_distance = abs(midi - reference)
    for shift in (-24.0, -12.0, 12.0, 24.0):
        candidate = midi + shift
        distance = abs(candidate - reference)
        if distance < best_distance:
            best = candidate
            best_distance = distance
    return best


def extract_pitch_frames(audio: np.ndarray, config: PitchTrackConfig) -> list[PitchFrame]:
    """
    Extract time-aligned pitch frames from a mono waveform.

    Unvoiced frames are still returned with ``midi=0.0`` so downstream stages can
    detect silence spans without reconstructing frame timing.
    """
    import librosa  # noqa: PLC0415

    if audio.ndim != 1:
        raise ValueError("audio must be mono (1D ndarray)")

    if len(audio) == 0:
        return []

    f0_hz, voiced_flag, voiced_prob = librosa.pyin(
        audio.astype(np.float32, copy=False),
        fmin=config.fmin_hz,
        fmax=config.fmax_hz,
        sr=config.sample_rate,
        frame_length=config.frame_length,
        hop_length=config.hop_length,
        center=False,
    )

    frames: list[PitchFrame] = []
    previous_voiced_midi = 0.0

    for idx in range(len(f0_hz)):
        time_ms = (idx * config.hop_length * 1000.0) / config.sample_rate
        confidence = float(voiced_prob[idx]) if voiced_prob is not None else 0.0
        voiced = bool(voiced_flag[idx]) if voiced_flag is not None else False
        frequency_hz = float(f0_hz[idx]) if not np.isnan(f0_hz[idx]) else 0.0

        midi = 0.0
        if voiced and confidence >= config.confidence_threshold and frequency_hz > 0.0:
            midi = hz_to_midi(frequency_hz)
            midi = _closest_octave(midi, previous_voiced_midi)
            previous_voiced_midi = midi

        frames.append(PitchFrame(time_ms=time_ms, midi=midi, confidence=confidence))

    return frames
