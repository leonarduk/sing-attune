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
OCTAVE_ERROR_SEMITONES = 12.0
OCTAVE_ERROR_TOLERANCE = 1.5
NEIGHBOR_STABILITY_TOLERANCE = 2.0


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

    octave_shift = round((reference - midi) / OCTAVE_ERROR_SEMITONES)
    return midi + (octave_shift * OCTAVE_ERROR_SEMITONES)


def _is_likely_isolated_octave_error(previous_midi: float, midi: float, next_midi: float) -> bool:
    """Return True when ``midi`` is likely an isolated octave-tracking error."""
    if previous_midi <= 0.0 or midi <= 0.0 or next_midi <= 0.0:
        return False

    previous_next_stable = abs(previous_midi - next_midi) <= NEIGHBOR_STABILITY_TOLERANCE
    previous_is_octave = (
        abs(abs(midi - previous_midi) - OCTAVE_ERROR_SEMITONES) <= OCTAVE_ERROR_TOLERANCE
    )
    next_is_octave = (
        abs(abs(midi - next_midi) - OCTAVE_ERROR_SEMITONES) <= OCTAVE_ERROR_TOLERANCE
    )
    return previous_next_stable and previous_is_octave and next_is_octave


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

    if len(audio) < config.frame_length:
        return [PitchFrame(time_ms=0.0, midi=0.0, confidence=0.0)]

    f0_hz, voiced_flag, voiced_prob = librosa.pyin(
        audio.astype(np.float32, copy=False),
        fmin=config.fmin_hz,
        fmax=config.fmax_hz,
        sr=config.sample_rate,
        frame_length=config.frame_length,
        hop_length=config.hop_length,
        center=False,
    )

    raw_midis: list[float] = []
    frame_times_ms: list[float] = []
    confidences: list[float] = []

    for idx in range(len(f0_hz)):
        time_ms = (idx * config.hop_length * 1000.0) / config.sample_rate
        confidence = float(voiced_prob[idx]) if voiced_prob is not None else 0.0
        voiced = bool(voiced_flag[idx]) if voiced_flag is not None else False
        frequency_hz = float(f0_hz[idx]) if not np.isnan(f0_hz[idx]) else 0.0

        midi = 0.0
        if voiced and confidence >= config.confidence_threshold and frequency_hz > 0.0:
            midi = hz_to_midi(frequency_hz)

        frame_times_ms.append(time_ms)
        confidences.append(confidence)
        raw_midis.append(midi)

    corrected_midis = list(raw_midis)
    for idx in range(1, len(raw_midis) - 1):
        previous_midi = raw_midis[idx - 1]
        midi = raw_midis[idx]
        next_midi = raw_midis[idx + 1]

        if _is_likely_isolated_octave_error(previous_midi, midi, next_midi):
            reference_midi = (previous_midi + next_midi) / 2.0
            corrected_midis[idx] = _closest_octave(midi, reference_midi)

    frames: list[PitchFrame] = []
    for time_ms, midi, confidence in zip(frame_times_ms, corrected_midis, confidences, strict=True):
        frames.append(PitchFrame(time_ms=time_ms, midi=midi, confidence=confidence))

    return frames
