"""Tests for duration quantization into notation-domain events."""

from __future__ import annotations

import math

import pytest

from backend.models.transcription import NoteEvent
from backend.music import ScoreMetadata, quantize_note_events, score_model_from_quantized_events
from backend.music.notation_policy import V1_NOTATION_POLICY


def _hz_from_midi(midi: int) -> float:
    return 440.0 * (2 ** ((midi - 69) / 12))


class TestQuantizeNoteEvents:
    def test_inserts_rest_and_prefers_dotted_values(self):
        events = [
            NoteEvent(start_time=0.5, end_time=2.0, pitch=_hz_from_midi(60), confidence=0.9),
        ]

        quantized = quantize_note_events(events, tempo_bpm=120.0)

        assert [event.event_type for event in quantized] == ["rest", "note"]
        assert quantized[0].duration_beats == pytest.approx(1.0)
        assert quantized[1].duration_beats == pytest.approx(3.0)
        assert quantized[1].pitch == "C4"
        assert not quantized[1].tie_start
        assert not quantized[1].tie_stop

    def test_splits_notes_crossing_barlines_into_tied_events(self):
        events = [
            NoteEvent(start_time=1.5, end_time=2.5, pitch=_hz_from_midi(62), confidence=0.8),
        ]

        quantized = quantize_note_events(events, tempo_bpm=120.0)

        assert [event.duration_beats for event in quantized] == pytest.approx([3.0, 1.0, 1.0])
        assert quantized[1].event_type == "note"
        assert quantized[2].event_type == "note"
        assert quantized[1].tie_start is True
        assert quantized[1].tie_stop is False
        assert quantized[2].tie_start is False
        assert quantized[2].tie_stop is True

    def test_is_deterministic_for_fixed_input(self):
        events = [
            NoteEvent(start_time=0.0, end_time=0.375, pitch=_hz_from_midi(64), confidence=0.95),
            NoteEvent(start_time=0.5, end_time=1.25, pitch=_hz_from_midi(67), confidence=0.9),
        ]

        first = quantize_note_events(events, tempo_bpm=120.0, notation_policy=V1_NOTATION_POLICY)
        second = quantize_note_events(events, tempo_bpm=120.0, notation_policy=V1_NOTATION_POLICY)

        assert first == second

    def test_output_adapts_into_score_model_without_measure_overflow(self):
        events = [
            NoteEvent(start_time=0.0, end_time=0.75, pitch=_hz_from_midi(60), confidence=1.0),
            NoteEvent(start_time=1.0, end_time=2.5, pitch=_hz_from_midi(64), confidence=1.0),
        ]

        quantized = quantize_note_events(events, tempo_bpm=120.0, time_signature="4/4")
        score_model = score_model_from_quantized_events(
            quantized,
            metadata=ScoreMetadata(tempo_bpm=120.0, time_signature="4/4"),
        )

        assert [measure.number for measure in score_model.measures] == [1, 2]
        assert math.isclose(score_model.measures[0].total_duration_beats, 4.0)
        assert math.isclose(score_model.measures[1].total_duration_beats, 1.0)

    def test_rejects_non_positive_tempo(self):
        with pytest.raises(ValueError, match="tempo_bpm must be positive"):
            quantize_note_events(
                [NoteEvent(start_time=0.0, end_time=0.5, pitch=_hz_from_midi(60), confidence=1.0)],
                tempo_bpm=0.0,
            )
