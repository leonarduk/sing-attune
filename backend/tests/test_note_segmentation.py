"""Tests for note segmentation heuristics (issue #259)."""

from backend.audio.note_segmentation import NoteSegmentationConfig, segment_notes
from backend.models.transcription import PitchFrame


def _frames(midis: list[float], frame_step_ms: float = 20.0, confidence: float = 0.9) -> list[PitchFrame]:
    return [
        PitchFrame(time_ms=index * frame_step_ms, midi=midi, confidence=confidence if midi > 0.0 else 0.0)
        for index, midi in enumerate(midis)
    ]


class TestSegmentNotes:
    def test_returns_empty_for_no_frames(self):
        assert segment_notes([]) == []

    def test_vibrato_stays_single_note(self):
        frames = _frames([69.0, 69.4, 68.7, 69.5, 68.9, 69.2, 69.0, 68.8])

        notes = segment_notes(frames)

        assert len(notes) == 1
        assert abs(notes[0].pitch - 69.0) < 0.5
        assert notes[0].start_time == 0.0
        assert notes[0].end_time > 0.15

    def test_micro_jitter_and_short_dropout_do_not_split_note(self):
        frames = _frames([60.0, 60.1, 0.0, 59.9, 60.2, 60.0, 59.8])

        notes = segment_notes(frames)

        assert len(notes) == 1
        assert abs(notes[0].pitch - 60.0) < 0.3

    def test_genuine_pitch_change_creates_new_note(self):
        frames = _frames([60.0] * 6 + [64.0] * 6)

        notes = segment_notes(frames)

        assert len(notes) == 2
        assert abs(notes[0].pitch - 60.0) < 0.1
        assert abs(notes[1].pitch - 64.0) < 0.1
        assert notes[0].end_time <= notes[1].start_time

    def test_silence_gap_splits_repeated_note_reattack(self):
        frames = _frames([67.0] * 5 + [0.0] * 5 + [67.0] * 5)

        notes = segment_notes(
            frames,
            NoteSegmentationConfig(max_gap_ms=40.0, min_note_ms=60.0),
        )

        assert len(notes) == 2
        assert abs(notes[0].pitch - 67.0) < 0.1
        assert abs(notes[1].pitch - 67.0) < 0.1
        assert notes[0].end_time <= 0.12
        assert notes[1].start_time >= 0.18

    def test_very_short_segments_are_suppressed(self):
        frames = _frames([60.0, 60.0, 0.0, 0.0, 0.0])

        notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=80.0))

        assert notes == []
