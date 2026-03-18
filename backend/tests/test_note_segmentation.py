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

    def test_single_outlier_frame_does_not_split_stable_note(self):
        frames = _frames([69.0, 69.0, 72.0, 69.0, 69.0, 69.0])

        notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=20.0))

        assert len(notes) == 1
        assert abs(notes[0].pitch - 69.0) < 0.1

    def test_short_adjacent_notes_are_filtered_instead_of_blended(self):
        frames = _frames([60.0, 60.0, 64.0, 64.0])

        notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=60.0))

        assert notes == []

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

    def test_missing_frames_create_silence_boundary_for_live_pitch_streams(self):
        frames = [
            PitchFrame(time_ms=0.0, midi=67.0, confidence=0.9),
            PitchFrame(time_ms=20.0, midi=67.0, confidence=0.9),
            PitchFrame(time_ms=40.0, midi=67.0, confidence=0.9),
            PitchFrame(time_ms=1000.0, midi=67.0, confidence=0.9),
            PitchFrame(time_ms=1020.0, midi=67.0, confidence=0.9),
            PitchFrame(time_ms=1040.0, midi=67.0, confidence=0.9),
        ]

        notes = segment_notes(
            frames,
            NoteSegmentationConfig(max_gap_ms=40.0, min_note_ms=40.0),
        )

        assert len(notes) == 2
        assert notes[0].end_time <= 0.06
        assert notes[1].start_time >= 1.0

    def test_max_gap_ms_respects_floor_conversion(self):
        frames = _frames([67.0, 67.0, 0.0, 0.0, 67.0, 67.0])

        notes = segment_notes(
            frames,
            NoteSegmentationConfig(max_gap_ms=30.0, min_note_ms=40.0),
        )

        assert len(notes) == 2

    def test_gap_between_different_pitches_is_not_bridged(self):
        frames = _frames([60.0, 0.0, 64.0, 64.0])

        notes = segment_notes(
            frames,
            NoteSegmentationConfig(max_gap_ms=20.0, min_note_ms=20.0),
        )

        assert len(notes) == 2
        assert notes[0].pitch == 60.0
        assert notes[1].pitch == 64.0

    def test_zero_gap_tolerance_disables_gap_bridging(self):
        frames = _frames([67.0, 0.0, 67.0, 67.0])

        notes = segment_notes(
            frames,
            NoteSegmentationConfig(max_gap_ms=0.0, min_note_ms=20.0),
        )

        assert len(notes) == 2
        assert notes[0].end_time <= notes[1].start_time

    def test_single_frame_clip_does_not_emit_false_note_by_default(self):
        frames = _frames([60.0])

        notes = segment_notes(frames)

        assert notes == []

    def test_single_frame_note_can_be_retained_with_zero_minimum_duration(self):
        frames = _frames([60.0])

        notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=0.0))

        assert len(notes) == 1
        assert notes[0].start_time == 0.0
        assert notes[0].end_time == 0.0
        assert notes[0].pitch == 60.0

    def test_very_short_segments_are_suppressed(self):
        frames = _frames([60.0, 60.0, 0.0, 0.0, 0.0])

        notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=80.0))

        assert notes == []
