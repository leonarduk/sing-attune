"""Tests for duration quantization into notation-domain events."""

from __future__ import annotations

import math

import pytest

from backend.models.transcription import NoteEvent
from backend.music import ScoreMetadata, quantize_note_events, score_model_from_quantized_events
from backend.music.quantization import (
    _build_rest_events,
    _choose_duration,
    _is_readable_choice,
    _midi_to_pitch_name,
)
from backend.music.notation_policy import V1_NOTATION_POLICY


def _hz_from_midi(midi: int) -> float:
    return 440.0 * (2 ** ((midi - 69) / 12))


class TestQuantizeNoteEvents:

    def test_inserts_initial_rest_before_first_note(self):
        events = [
            NoteEvent(start_time=1.0, end_time=1.5, pitch=_hz_from_midi(60), confidence=0.9),
        ]

        quantized = quantize_note_events(events, tempo_bpm=120.0)

        assert [event.event_type for event in quantized] == ["rest", "note"]
        assert quantized[0].duration_beats == pytest.approx(2.0)

    def test_drops_very_short_note_instead_of_inflating_it(self):
        events = [
            NoteEvent(start_time=0.01, end_time=0.02, pitch=_hz_from_midi(60), confidence=0.9),
        ]

        assert quantize_note_events(events, tempo_bpm=120.0) == []

    def test_drops_zero_length_note(self):
        events = [
            NoteEvent(start_time=0.5, end_time=0.5, pitch=_hz_from_midi(60), confidence=0.9),
        ]

        assert quantize_note_events(events, tempo_bpm=120.0) == []

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

    def test_decomposes_off_grid_dotted_half_into_tied_fragments(self):
        # Regression test for issue #430: `_is_readable_choice` used to bucket
        # the 3.0-beat (dotted half) duration with the unconditionally-True
        # simple durations, so a candidate starting mid-beat was emitted as a
        # single off-grid dotted half instead of being decomposed like the
        # 1.5/0.75 dotted cases. Beat 0.25 has 3.0 beats remaining before the
        # next beat-aligned position, so this exercises exactly that bucket.
        events = [
            NoteEvent(start_time=0.125, end_time=1.625, pitch=_hz_from_midi(60), confidence=0.9),
        ]

        quantized = quantize_note_events(events, tempo_bpm=120.0)

        assert [event.event_type for event in quantized] == ["rest", "note", "note"]
        assert quantized[0].duration_beats == pytest.approx(0.25)
        note_events = quantized[1:]
        # No single off-grid 3.0-beat note: the candidate is decomposed into
        # beat-aligned fragments instead (2.0 + 1.0 rather than one 3.0 span).
        assert [event.duration_beats for event in note_events] == pytest.approx([2.0, 1.0])
        assert all(event.duration_beats != pytest.approx(3.0) for event in note_events)
        assert [event.pitch for event in note_events] == ["C4", "C4"]
        assert [event.tie_start for event in note_events] == [True, False]
        assert [event.tie_stop for event in note_events] == [False, True]

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


class TestQuantizationHelpers:
    def test_build_rest_events_returns_empty_for_non_positive_span(self):
        assert (
            _build_rest_events(
                2.0,
                2.0,
                seconds_per_beat=0.5,
                beats_per_measure=4.0,
                notation_policy=V1_NOTATION_POLICY,
            )
            == []
        )

    def test_choose_duration_clamps_when_remaining_is_below_smallest_candidate(self):
        assert _choose_duration(0.0, 0.1, V1_NOTATION_POLICY) == pytest.approx(0.1)

    def test_choose_duration_rejects_off_grid_dotted_half(self):
        # Beat-aligned cursor: a 3.0-beat (dotted half) candidate is still the
        # readable choice when the full 3.0 beats are available.
        assert _choose_duration(0.0, 3.0, V1_NOTATION_POLICY) == pytest.approx(3.0)
        # Off-grid cursor (beat-offset 0.25): the 3.0-beat candidate must be
        # rejected in favour of the next readable duration (2.0), not emitted
        # as a single off-grid dotted half. See issue #430.
        assert _choose_duration(0.25, 3.0, V1_NOTATION_POLICY) == pytest.approx(2.0)

    def test_is_readable_choice_requires_beat_alignment_for_dotted_half(self):
        # Dotted half (3.0) must require beat alignment just like its dotted
        # sibling, the dotted quarter (1.5) — both were previously handled by
        # separate branches with 3.0 wrongly grouped into the always-True set.
        assert _is_readable_choice(0.0, 3.0) is True
        assert _is_readable_choice(0.25, 3.0) is False
        assert _is_readable_choice(0.0, 1.5) is True
        assert _is_readable_choice(0.25, 1.5) is False

    def test_supports_extreme_tempo_values(self):
        event = NoteEvent(start_time=0.0, end_time=0.02, pitch=_hz_from_midi(60), confidence=0.9)

        fast = quantize_note_events([event], tempo_bpm=6000.0)
        slow = quantize_note_events([NoteEvent(start_time=0.0, end_time=6.0, pitch=_hz_from_midi(60), confidence=0.9)], tempo_bpm=10.0)

        assert fast
        assert slow
        assert all(event.duration_beats > 0 for event in fast + slow)

    def test_splits_multiple_barline_crossings_into_tied_events(self):
        events = [
            NoteEvent(start_time=0.0, end_time=5.0, pitch=_hz_from_midi(65), confidence=0.8),
        ]

        quantized = quantize_note_events(events, tempo_bpm=60.0)

        note_events = [event for event in quantized if event.event_type == "note"]
        assert [event.duration_beats for event in note_events] == pytest.approx([4.0, 1.0])
        assert note_events[0].tie_start is True
        assert note_events[1].tie_stop is True


class TestPitchNameValidation:
    @pytest.mark.parametrize(
        ("frequency_hz", "match"),
        [
            (math.nan, "must be finite"),
            (math.inf, "must be finite"),
            (0.0, "must be positive"),
            (-1.0, "must be positive"),
            (_hz_from_midi(-1), "between 0 and 127"),
        ],
    )
    def test_rejects_invalid_or_out_of_range_frequencies(self, frequency_hz: float, match: str):
        with pytest.raises(ValueError, match=match):
            _midi_to_pitch_name(frequency_hz)

    def test_accepts_lowest_renderable_midi(self):
        assert _midi_to_pitch_name(_hz_from_midi(0)) == "C-1"
