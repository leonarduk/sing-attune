"""Tests for transcription tempo/key analysis helpers."""

from __future__ import annotations

import math

from backend.audio.music_analysis import estimate_key, estimate_tempo
from backend.models.transcription import NoteEvent


A4_HZ = 440.0


def _hz_from_midi(midi: int) -> float:
    return A4_HZ * (2.0 ** ((midi - 69) / 12.0))


class TestEstimateTempo:
    def test_returns_none_for_too_few_notes(self):
        notes = [NoteEvent(start_time=0.0, end_time=0.5, pitch=A4_HZ, confidence=0.9)]

        assert estimate_tempo(notes) is None

    def test_estimates_simple_quarter_note_pulse(self):
        beat_interval = 60.0 / 92.0
        notes = [
            NoteEvent(
                start_time=index * beat_interval,
                end_time=(index * beat_interval) + (beat_interval * 0.8),
                pitch=_hz_from_midi(60 + (index % 3)),
                confidence=0.92,
            )
            for index in range(8)
        ]

        tempo = estimate_tempo(notes)

        assert tempo is not None
        assert tempo == 92.0

    def test_normalizes_half_time_estimate_into_rehearsal_range(self):
        notes = [
            NoteEvent(
                start_time=index * 2.0,
                end_time=(index * 2.0) + 1.5,
                pitch=_hz_from_midi(67),
                confidence=0.9,
            )
            for index in range(4)
        ]

        tempo = estimate_tempo(notes)

        assert tempo == 60.0


class TestEstimateKey:
    def test_detects_c_major_from_weighted_pitch_classes(self):
        notes = [
            NoteEvent(0.0, 0.8, _hz_from_midi(60), 0.95),
            NoteEvent(0.8, 1.6, _hz_from_midi(64), 0.95),
            NoteEvent(1.6, 2.4, _hz_from_midi(67), 0.95),
            NoteEvent(2.4, 3.2, _hz_from_midi(72), 0.95),
            NoteEvent(3.2, 4.0, _hz_from_midi(67), 0.95),
        ]

        assert estimate_key(notes) == "C major"

    def test_returns_none_when_key_signal_is_ambiguous(self):
        notes = [
            NoteEvent(0.0, 0.5, _hz_from_midi(60), 0.9),
            NoteEvent(0.5, 1.0, _hz_from_midi(61), 0.9),
            NoteEvent(1.0, 1.5, _hz_from_midi(62), 0.9),
            NoteEvent(1.5, 2.0, _hz_from_midi(63), 0.9),
            NoteEvent(2.0, 2.5, _hz_from_midi(64), 0.9),
            NoteEvent(2.5, 3.0, _hz_from_midi(65), 0.9),
        ]

        assert estimate_key(notes, min_confidence_margin=0.5) is None

    def test_ignores_invalid_and_non_positive_pitch_events(self):
        notes = [
            NoteEvent(0.0, 0.0, _hz_from_midi(60), 0.8),
            NoteEvent(0.1, 0.6, 0.0, 0.8),
            NoteEvent(0.6, 1.1, math.inf, 0.8),
            NoteEvent(1.1, 1.8, _hz_from_midi(69), 0.9),
            NoteEvent(1.8, 2.5, _hz_from_midi(72), 0.9),
            NoteEvent(2.5, 3.2, _hz_from_midi(76), 0.9),
        ]

        assert estimate_key(notes) == "A minor"
