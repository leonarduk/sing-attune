"""Tests for shared transcription domain models."""

import pytest

from backend.models.transcription import (
    NoteEvent,
    PitchFrame,
    RestEvent,
    TranscriptionOptions,
    TranscriptionSummary,
)


class TestPitchFrame:
    def test_to_dict(self):
        frame = PitchFrame(time_ms=125.0, midi=60.3, confidence=0.92)
        assert frame.to_dict() == {"time_ms": 125.0, "midi": 60.3, "confidence": 0.92}

    def test_immutable(self):
        frame = PitchFrame(time_ms=0.0, midi=69.0, confidence=0.8)
        with pytest.raises((AttributeError, TypeError)):
            frame.midi = 70.0  # type: ignore[misc]


class TestNoteEvent:
    def test_duration_seconds(self):
        event = NoteEvent(start_time=1.25, end_time=2.0, pitch=440.0, confidence=0.95)
        assert event.duration_seconds == 0.75

    def test_duration_clamps_negative(self):
        event = NoteEvent(start_time=2.0, end_time=1.25, pitch=440.0, confidence=0.95)
        assert event.duration_seconds == 0.0


class TestRestEvent:
    def test_duration_seconds(self):
        event = RestEvent(start_time=3.0, end_time=3.5)
        assert event.duration_seconds == 0.5


class TestTranscriptionMetadata:
    def test_options_defaults(self):
        options = TranscriptionOptions()
        assert options.tempo_bpm is None
        assert options.time_signature is None

    def test_summary_fields(self):
        summary = TranscriptionSummary(
            note_count=12,
            duration_seconds=8.4,
            average_confidence=0.86,
        )
        assert summary.note_count == 12
        assert summary.duration_seconds == 8.4
        assert summary.average_confidence == 0.86
