"""Tests for transcription tempo/key analysis helpers."""

from __future__ import annotations

import math

import pytest

from backend.audio.music_analysis import _normalize_bpm, _pitch_class_index, estimate_key, estimate_tempo
from backend.models.transcription import NoteEvent


A4_HZ = 440.0


def _hz_from_midi(midi: int) -> float:
    return A4_HZ * (2.0 ** ((midi - 69) / 12.0))


class TestEstimateTempo:
    def test_returns_none_for_too_few_notes(self):
        notes = [NoteEvent(start_time=0.0, end_time=0.5, pitch=A4_HZ, confidence=0.9)]

        assert estimate_tempo(notes) is None

    def test_returns_none_when_all_notes_share_the_same_onset(self):
        notes = [
            NoteEvent(start_time=0.0, end_time=0.5, pitch=_hz_from_midi(60), confidence=0.9),
            NoteEvent(start_time=0.0, end_time=0.6, pitch=_hz_from_midi(64), confidence=0.9),
            NoteEvent(start_time=0.0, end_time=0.7, pitch=_hz_from_midi(67), confidence=0.9),
        ]

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


    def test_uses_even_interval_median_for_tempo(self):
        notes = [
            NoteEvent(0.0, 0.3, _hz_from_midi(60), 0.9),
            NoteEvent(0.5, 0.8, _hz_from_midi(62), 0.9),
            NoteEvent(1.0, 1.3, _hz_from_midi(64), 0.9),
            NoteEvent(2.0, 2.3, _hz_from_midi(65), 0.9),
            NoteEvent(3.0, 3.3, _hz_from_midi(67), 0.9),
        ]

        assert estimate_tempo(notes) == 80.0

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
    def test_detects_c_major_from_diatonic_scale(self):
        notes = [
            NoteEvent(index * 0.5, (index * 0.5) + 0.4, _hz_from_midi(midi), 0.95)
            for index, midi in enumerate((60, 62, 64, 65, 67, 69, 71, 72))
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

    def test_returns_none_when_too_few_positive_pitch_notes_remain(self):
        notes = [
            NoteEvent(0.0, 0.6, _hz_from_midi(60), 0.9),
            NoteEvent(0.6, 1.2, _hz_from_midi(63), 0.9),
            NoteEvent(1.2, 1.8, 0.0, 0.9),
        ]

        assert estimate_key(notes) is None

    def test_uses_low_confidence_floor_when_all_note_confidence_is_zero(self):
        notes = [
            NoteEvent(0.0, 0.7, _hz_from_midi(60), 0.0),
            NoteEvent(0.7, 1.4, _hz_from_midi(64), 0.0),
            NoteEvent(1.4, 2.1, _hz_from_midi(67), 0.0),
        ]

        assert estimate_key(notes) == "C major"

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


class TestPitchClassIndex:
    def test_rejects_non_positive_pitch(self):
        with pytest.raises(ValueError, match="must be positive"):
            _pitch_class_index(0.0)


class TestNormalizeBpm:
    def test_returns_none_for_invalid_bpm(self):
        assert _normalize_bpm(0.0) is None
        assert _normalize_bpm(math.inf) is None

    def test_folds_high_bpm_into_reasonable_range(self):
        assert _normalize_bpm(320.0) == 160.0
