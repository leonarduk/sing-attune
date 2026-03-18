"""Tests for the internal notation-domain score model."""

import pytest

from backend.music import score_model as score_model_module
from backend.music.score_model import (
    LyricSyllabic,
    NoteScoreEvent,
    QuantizedEvent,
    RestScoreEvent,
    ScoreMetadata,
    score_model_from_quantized_events,
)


class TestScoreMetadata:
    def test_beats_per_measure_for_common_time(self):
        metadata = ScoreMetadata(time_signature="4/4")

        assert metadata.beats_per_measure == 4.0

    def test_beats_per_measure_for_compound_signature(self):
        metadata = ScoreMetadata(time_signature="6/8")

        assert metadata.beats_per_measure == 3.0

    def test_rejects_invalid_time_signature_format(self):
        with pytest.raises(ValueError, match="numerator/denominator format"):
            ScoreMetadata(time_signature="4").beats_per_measure

    def test_rejects_non_positive_time_signature_parts(self):
        with pytest.raises(ValueError, match="numerator must be positive"):
            ScoreMetadata(time_signature="0/4").beats_per_measure

        with pytest.raises(ValueError, match="denominator must be positive"):
            ScoreMetadata(time_signature="4/0").beats_per_measure


class TestScoreEvents:
    def test_note_supports_manual_lyrics(self):
        event = NoteScoreEvent(
            pitch="C4",
            duration_beats=1.0,
            source_start_time=0.0,
            source_end_time=0.5,
            confidence=0.9,
            lyric_text="Hal",
            lyric_syllabic=LyricSyllabic.BEGIN,
        )

        assert event.event_type == "note"
        assert event.lyric_text == "Hal"
        assert event.lyric_syllabic == LyricSyllabic.BEGIN

    def test_note_rejects_lyric_syllabic_without_text(self):
        with pytest.raises(ValueError, match="lyric_syllabic requires lyric_text"):
            NoteScoreEvent(
                pitch="D4",
                duration_beats=1.0,
                source_start_time=0.0,
                source_end_time=0.5,
                lyric_syllabic=LyricSyllabic.SINGLE,
            )

    @pytest.mark.parametrize(
        ("duration_beats", "source_start_time", "source_end_time", "confidence", "match"),
        [
            (0.0, 0.0, 0.5, 1.0, "duration_beats must be positive"),
            (1.0, 1.0, 0.5, 1.0, "source_end_time must be >= source_start_time"),
            (1.0, 0.0, 0.5, 1.5, "confidence must be between 0.0 and 1.0"),
        ],
    )
    def test_note_rejects_invalid_ranges(
        self,
        duration_beats,
        source_start_time,
        source_end_time,
        confidence,
        match,
    ):
        with pytest.raises(ValueError, match=match):
            NoteScoreEvent(
                pitch="E4",
                duration_beats=duration_beats,
                source_start_time=source_start_time,
                source_end_time=source_end_time,
                confidence=confidence,
            )

    def test_rest_rejects_ties(self):
        with pytest.raises(ValueError, match="Rest events cannot carry ties"):
            RestScoreEvent(
                duration_beats=1.0,
                source_start_time=0.0,
                source_end_time=0.5,
                tie_start=True,
            )

    @pytest.mark.parametrize(
        ("duration_beats", "source_start_time", "source_end_time", "confidence", "match"),
        [
            (0.0, 0.0, 0.5, 1.0, "duration_beats must be positive"),
            (1.0, 1.0, 0.5, 1.0, "source_end_time must be >= source_start_time"),
            (1.0, 0.0, 0.5, -0.1, "confidence must be between 0.0 and 1.0"),
        ],
    )
    def test_rest_rejects_invalid_ranges(
        self,
        duration_beats,
        source_start_time,
        source_end_time,
        confidence,
        match,
    ):
        with pytest.raises(ValueError, match=match):
            RestScoreEvent(
                duration_beats=duration_beats,
                source_start_time=source_start_time,
                source_end_time=source_end_time,
                confidence=confidence,
            )


class TestScoreModelAdapter:
    def test_builds_simple_melody_with_measures(self):
        model = score_model_from_quantized_events(
            [
                QuantizedEvent(
                    event_type="note",
                    pitch="C4",
                    duration_beats=1.0,
                    source_start_time=0.0,
                    source_end_time=0.5,
                    lyric_text="Twin",
                    lyric_syllabic=LyricSyllabic.SINGLE,
                ),
                QuantizedEvent(
                    event_type="note",
                    pitch="D4",
                    duration_beats=1.0,
                    source_start_time=0.5,
                    source_end_time=1.0,
                ),
                QuantizedEvent(
                    event_type="rest",
                    duration_beats=2.0,
                    source_start_time=1.0,
                    source_end_time=2.0,
                ),
                QuantizedEvent(
                    event_type="note",
                    pitch="E4",
                    duration_beats=4.0,
                    source_start_time=2.0,
                    source_end_time=4.0,
                    tie_start=True,
                ),
            ],
            metadata=ScoreMetadata(tempo_bpm=88, key_signature="C", time_signature="4/4"),
        )

        assert model.metadata.tempo_bpm == 88
        assert len(model.measures) == 2
        assert [measure.number for measure in model.measures] == [1, 2]
        assert [event.event_type for event in model.measures[0].events] == ["note", "note", "rest"]
        assert model.measures[1].events[0].tie_start is True

    def test_rejects_measure_overflow_from_quantization_output(self):
        with pytest.raises(ValueError, match="overflow measure 1"):
            score_model_from_quantized_events(
                [
                    QuantizedEvent(
                        event_type="note",
                        pitch="C4",
                        duration_beats=3.0,
                        source_start_time=0.0,
                        source_end_time=1.0,
                    ),
                    QuantizedEvent(
                        event_type="note",
                        pitch="D4",
                        duration_beats=2.0,
                        source_start_time=1.0,
                        source_end_time=2.0,
                    ),
                ],
                metadata=ScoreMetadata(time_signature="4/4"),
            )

    def test_quantized_rest_cannot_carry_lyrics(self):
        with pytest.raises(ValueError, match="rest events cannot include pitch or lyrics"):
            QuantizedEvent(
                event_type="rest",
                duration_beats=1.0,
                source_start_time=0.0,
                source_end_time=0.5,
                lyric_text="oops",
            ).to_score_event()

    def test_quantized_note_requires_pitch(self):
        with pytest.raises(ValueError, match="require pitch"):
            QuantizedEvent(
                event_type="note",
                duration_beats=1.0,
                source_start_time=0.0,
                source_end_time=0.5,
            ).to_score_event()

    def test_iter_events_flattens_measures_in_order(self):
        model = score_model_from_quantized_events(
            [
                QuantizedEvent(
                    event_type="note",
                    pitch="C4",
                    duration_beats=4.0,
                    source_start_time=0.0,
                    source_end_time=1.0,
                ),
                QuantizedEvent(
                    event_type="rest",
                    duration_beats=1.0,
                    source_start_time=1.0,
                    source_end_time=1.5,
                ),
            ],
            metadata=ScoreMetadata(time_signature="4/4"),
        )

        assert [event.event_type for event in model.iter_events()] == ["note", "rest"]

    def test_accepts_measure_boundary_with_floating_point_rounding(self):
        model = score_model_from_quantized_events(
            [
                QuantizedEvent(
                    event_type="note",
                    pitch="C4",
                    duration_beats=1.333333333,
                    source_start_time=0.0,
                    source_end_time=0.5,
                ),
                QuantizedEvent(
                    event_type="note",
                    pitch="D4",
                    duration_beats=1.333333333,
                    source_start_time=0.5,
                    source_end_time=1.0,
                ),
                QuantizedEvent(
                    event_type="note",
                    pitch="E4",
                    duration_beats=1.333333334,
                    source_start_time=1.0,
                    source_end_time=1.5,
                ),
            ],
            metadata=ScoreMetadata(time_signature="4/4"),
        )

        assert len(model.measures) == 1
        assert model.measures[0].total_duration_beats == pytest.approx(4.0)

    def test_module_remains_music21_free(self):
        source = open(score_model_module.__file__, encoding="utf-8").read()

        assert "music21" not in source
