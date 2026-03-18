"""Helpers for estimating musical tempo and key from detected note events."""

from __future__ import annotations

from collections.abc import Sequence
import math

from backend.models.transcription import NoteEvent

MIN_NOTES_FOR_TEMPO = 2
MIN_NOTES_FOR_KEY = 3
MAX_REASONABLE_BPM = 240.0
MIN_REASONABLE_BPM = 40.0
DEFAULT_LOW_CONFIDENCE = 0.35

_MAJOR_PROFILE = (
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
)
_MINOR_PROFILE = (
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
)
_NOTE_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")


def _valid_note_events(events: Sequence[NoteEvent]) -> list[NoteEvent]:
    """Return note events with positive duration and finite pitch values."""
    valid: list[NoteEvent] = []
    for event in events:
        if event.duration_seconds <= 0.0:
            continue
        if not math.isfinite(event.pitch):
            continue
        valid.append(event)
    return valid


def _normalize_bpm(raw_bpm: float) -> float | None:
    """Fold an estimated BPM into a musically useful range."""
    if not math.isfinite(raw_bpm) or raw_bpm <= 0.0:
        return None

    bpm = raw_bpm
    while bpm < MIN_REASONABLE_BPM:
        bpm *= 2.0
    while bpm > MAX_REASONABLE_BPM:
        bpm /= 2.0
    return bpm


def estimate_tempo(events: Sequence[NoteEvent]) -> float | None:
    """Estimate tempo in BPM from note onset spacing.

    The estimator uses the median inter-onset interval, which is robust against
    occasional rests and ornamentation in simple monophonic rehearsal takes.
    """
    valid_events = sorted(_valid_note_events(events), key=lambda event: event.start_time)
    if len(valid_events) < MIN_NOTES_FOR_TEMPO:
        return None

    onset_intervals = [
        current.start_time - previous.start_time
        for previous, current in zip(valid_events[:-1], valid_events[1:], strict=True)
        if (current.start_time - previous.start_time) > 0.0
    ]
    if not onset_intervals:
        return None

    onset_intervals.sort()
    midpoint = len(onset_intervals) // 2
    if len(onset_intervals) % 2 == 0:
        median_interval = (onset_intervals[midpoint - 1] + onset_intervals[midpoint]) / 2.0
    else:
        median_interval = onset_intervals[midpoint]

    return _normalize_bpm(60.0 / median_interval)


def _pitch_class_index(pitch_hz: float) -> int:
    midi = 69.0 + (12.0 * math.log2(pitch_hz / 440.0))
    return int(round(midi)) % 12


def _rotate_profile(profile: tuple[float, ...], steps: int) -> tuple[float, ...]:
    return profile[-steps:] + profile[:-steps]


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def estimate_key(events: Sequence[NoteEvent], *, min_confidence_margin: float = 0.15) -> str | None:
    """Estimate a musical key from pitch-class energy.

    Returns ``None`` when there are too few reliable notes or when the best key
    is not clearly separated from the runner-up.
    """
    valid_events = _valid_note_events(events)
    if len(valid_events) < MIN_NOTES_FOR_KEY:
        return None

    pitch_class_weights = [0.0] * 12
    total_weight = 0.0
    for event in valid_events:
        if event.pitch <= 0.0:
            continue
        confidence_weight = max(0.0, min(1.0, event.confidence))
        weight = event.duration_seconds * max(confidence_weight, DEFAULT_LOW_CONFIDENCE)
        pitch_class_weights[_pitch_class_index(event.pitch)] += weight
        total_weight += weight

    if total_weight <= 0.0:
        return None

    normalized = [weight / total_weight for weight in pitch_class_weights]

    candidates: list[tuple[float, str]] = []
    for tonic, name in enumerate(_NOTE_NAMES):
        major_score = _dot(normalized, _rotate_profile(_MAJOR_PROFILE, tonic))
        minor_score = _dot(normalized, _rotate_profile(_MINOR_PROFILE, tonic))
        candidates.append((major_score, f"{name} major"))
        candidates.append((minor_score, f"{name} minor"))

    candidates.sort(key=lambda item: item[0], reverse=True)
    best_score, best_key = candidates[0]
    runner_up_score = candidates[1][0] if len(candidates) > 1 else float("-inf")
    if best_score - runner_up_score < min_confidence_margin:
        return None
    return best_key
