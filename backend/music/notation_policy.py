"""Centralized notation rules for transcription v1."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from fractions import Fraction


class CrossBarNotePolicy(StrEnum):
    """How notes that cross measure boundaries are represented."""

    SPLIT_AND_TIE = "split_and_tie"


class DottedVsTiedPolicy(StrEnum):
    """How ambiguous durations are represented in notation."""

    PREFER_DOTTED_WITHIN_BEAT = "prefer_dotted_within_beat"


@dataclass(frozen=True)
class NotationPolicy:
    """Policy object controlling quantization and notation decisions.

    Durations are represented in quarter-note beats:
    - whole = 4.0
    - half = 2.0
    - quarter = 1.0
    - eighth = 0.5
    - sixteenth = 0.25
    """

    max_subdivision: Fraction = Fraction(1, 16)
    allowed_durations_beats: tuple[float, ...] = (4.0, 2.0, 1.0, 0.5, 0.25)
    cross_bar_notes: CrossBarNotePolicy = CrossBarNotePolicy.SPLIT_AND_TIE
    small_gap_merge_threshold_seconds: float = 0.05
    default_clef: str = "treble"
    default_time_signature: str = "4/4"
    dotted_vs_tied_policy: DottedVsTiedPolicy = DottedVsTiedPolicy.PREFER_DOTTED_WITHIN_BEAT
    _allowed_durations_set: frozenset[float] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_allowed_durations_set", frozenset(self.allowed_durations_beats))

    def is_allowed_duration(self, duration_beats: float) -> bool:
        """Return True when a duration can be emitted without decomposition."""

        return duration_beats in self._allowed_durations_set

    def should_merge_small_gap(self, gap_seconds: float) -> bool:
        """Return True when a short rest should merge into neighbouring notes."""

        return gap_seconds < self.small_gap_merge_threshold_seconds


V1_NOTATION_POLICY = NotationPolicy()
