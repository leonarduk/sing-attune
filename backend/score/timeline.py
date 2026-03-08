"""
Beat-to-time timeline — Day 3 implementation.

Maps beat positions (quarter notes from score start) to wall-clock
seconds and back, accounting for tempo changes. Handles the common
case of a single tempo and is structured to support multi-tempo
scores when needed.
"""

from __future__ import annotations

from .model import ScoreModel, TempoMark


class Timeline:
    """
    Maps beat positions (quarter-note beats) ↔ wall-clock seconds.

    Built from the tempo marks in a ScoreModel. Each segment between
    consecutive tempo marks has a constant BPM. Seeking and playback
    cursor sync both rely on this.

    Usage:
        timeline = Timeline(score)
        seconds = timeline.beat_to_seconds(12.0)
        beat    = timeline.seconds_to_beat(8.5)
    """

    def __init__(self, score: ScoreModel) -> None:
        # Build segment table: list of (beat_start, bpm, seconds_at_start)
        marks = sorted(score.tempo_marks, key=lambda m: m.beat)

        if not marks:
            marks = [TempoMark(beat=0.0, bpm=120.0)]

        self._segments: list[tuple[float, float, float]] = []  # (beat, bpm, t_offset)
        cumulative_seconds = 0.0

        for i, mark in enumerate(marks):
            self._segments.append((mark.beat, mark.bpm, cumulative_seconds))
            if i < len(marks) - 1:
                next_beat = marks[i + 1].beat
                beats_in_segment = next_beat - mark.beat
                cumulative_seconds += beats_in_segment * (60.0 / mark.bpm)

        self._total_beats = score.total_beats
        self._total_seconds = cumulative_seconds + (
            (self._total_beats - marks[-1].beat) * (60.0 / marks[-1].bpm)
            if marks else 0.0
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def beat_to_seconds(self, beat: float) -> float:
        """Convert a beat position to wall-clock seconds from the start."""
        beat = max(0.0, beat)
        seg_beat, seg_bpm, seg_t = self._segment_at_beat(beat)
        return seg_t + (beat - seg_beat) * (60.0 / seg_bpm)

    def seconds_to_beat(self, seconds: float) -> float:
        """Convert wall-clock seconds to a beat position."""
        seconds = max(0.0, seconds)
        seg_beat, seg_bpm, seg_t = self._segment_at_seconds(seconds)
        return seg_beat + (seconds - seg_t) * (seg_bpm / 60.0)

    @property
    def total_seconds(self) -> float:
        return self._total_seconds

    @property
    def total_beats(self) -> float:
        return self._total_beats

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _segment_at_beat(self, beat: float) -> tuple[float, float, float]:
        """Return the (beat_start, bpm, t_offset) segment active at the given beat."""
        active = self._segments[0]
        for seg in self._segments:
            if seg[0] <= beat:
                active = seg
            else:
                break
        return active

    def _segment_at_seconds(self, seconds: float) -> tuple[float, float, float]:
        """Return the segment active at the given wall-clock seconds."""
        active = self._segments[0]
        for seg in self._segments:
            if seg[2] <= seconds:
                active = seg
            else:
                break
        return active
