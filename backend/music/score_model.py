"""Internal notation-domain score model used between quantization and export."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, TypeAlias

MEASURE_EPSILON = 1e-9


class LyricSyllabic(StrEnum):
    """Supported MusicXML-compatible lyric syllabic values."""

    SINGLE = "single"
    BEGIN = "begin"
    MIDDLE = "middle"
    END = "end"


@dataclass(frozen=True)
class ScoreMetadata:
    """Notation metadata needed for export and score display."""

    tempo_bpm: float | None = None
    key_signature: str | None = None
    time_signature: str = "4/4"

    @property
    def beats_per_measure(self) -> float:
        """Return measure length in quarter-note beats for the time signature."""

        try:
            numerator_text, denominator_text = self.time_signature.split("/", maxsplit=1)
            numerator = int(numerator_text)
            denominator = int(denominator_text)
        except ValueError as exc:
            raise ValueError(
                "Time signature must use numerator/denominator format"
            ) from exc
        if numerator <= 0:
            raise ValueError("Time signature numerator must be positive")
        if denominator <= 0:
            raise ValueError("Time signature denominator must be positive")
        return numerator * (4 / denominator)


@dataclass(frozen=True)
class NoteScoreEvent:
    """Notation-domain note event with source timing traceability."""

    pitch: str
    duration_beats: float
    source_start_time: float
    source_end_time: float
    confidence: float = 1.0
    tie_start: bool = False
    tie_stop: bool = False
    lyric_text: str | None = None
    lyric_syllabic: LyricSyllabic | None = None
    event_type: Literal["note"] = field(default="note", init=False)

    def __post_init__(self) -> None:
        if self.duration_beats <= 0:
            raise ValueError("Note duration_beats must be positive")
        if self.source_end_time < self.source_start_time:
            raise ValueError("Note source_end_time must be >= source_start_time")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("Note confidence must be between 0.0 and 1.0")
        if self.lyric_syllabic is not None and self.lyric_text is None:
            raise ValueError("lyric_syllabic requires lyric_text on note events")


@dataclass(frozen=True)
class RestScoreEvent:
    """Notation-domain rest event with source timing traceability."""

    duration_beats: float
    source_start_time: float
    source_end_time: float
    confidence: float = 1.0
    tie_start: bool = False
    tie_stop: bool = False
    event_type: Literal["rest"] = field(default="rest", init=False)
    pitch: None = field(default=None, init=False)
    lyric_text: None = field(default=None, init=False)
    lyric_syllabic: None = field(default=None, init=False)

    def __post_init__(self) -> None:
        if self.duration_beats <= 0:
            raise ValueError("Rest duration_beats must be positive")
        if self.source_end_time < self.source_start_time:
            raise ValueError("Rest source_end_time must be >= source_start_time")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("Rest confidence must be between 0.0 and 1.0")
        if self.tie_start or self.tie_stop:
            raise ValueError("Rest events cannot carry ties")


ScoreEvent: TypeAlias = NoteScoreEvent | RestScoreEvent


@dataclass(frozen=True)
class Measure:
    """Single measure of notation-domain events."""

    number: int
    events: list[ScoreEvent]

    @property
    def total_duration_beats(self) -> float:
        return sum(event.duration_beats for event in self.events)


@dataclass(frozen=True)
class ScoreModel:
    """Internal score representation consumed by the MusicXML export layer."""

    metadata: ScoreMetadata
    measures: list[Measure]

    def iter_events(self) -> list[ScoreEvent]:
        """Return a flat list of events in score order."""

        return [event for measure in self.measures for event in measure.events]


@dataclass(frozen=True)
class QuantizedEvent:
    """Quantization output shape expected by the score-model adapter."""

    event_type: Literal["note", "rest"]
    duration_beats: float
    source_start_time: float
    source_end_time: float
    confidence: float = 1.0
    pitch: str | None = None
    tie_start: bool = False
    tie_stop: bool = False
    lyric_text: str | None = None
    lyric_syllabic: LyricSyllabic | None = None

    def to_score_event(self) -> ScoreEvent:
        """Convert a quantized notation candidate into a score-model event."""

        if self.event_type == "note":
            if self.pitch is None:
                raise ValueError("Quantized note events require pitch")
            return NoteScoreEvent(
                pitch=self.pitch,
                duration_beats=self.duration_beats,
                source_start_time=self.source_start_time,
                source_end_time=self.source_end_time,
                confidence=self.confidence,
                tie_start=self.tie_start,
                tie_stop=self.tie_stop,
                lyric_text=self.lyric_text,
                lyric_syllabic=self.lyric_syllabic,
            )

        if any(
            value is not None for value in (self.pitch, self.lyric_text, self.lyric_syllabic)
        ):
            raise ValueError("Quantized rest events cannot include pitch or lyrics")
        return RestScoreEvent(
            duration_beats=self.duration_beats,
            source_start_time=self.source_start_time,
            source_end_time=self.source_end_time,
            confidence=self.confidence,
            tie_start=self.tie_start,
            tie_stop=self.tie_stop,
        )


def score_model_from_quantized_events(
    events: list[QuantizedEvent],
    metadata: ScoreMetadata | None = None,
) -> ScoreModel:
    """Group quantized events into measures using score metadata.

    Raises when an event would overflow the current measure by more than the
    floating-point tolerance used for measure completion.
    """

    score_metadata = metadata or ScoreMetadata()
    beats_per_measure = score_metadata.beats_per_measure
    measures: list[Measure] = []
    current_events: list[ScoreEvent] = []
    current_duration = 0.0
    measure_number = 1

    for event in events:
        score_event = event.to_score_event()
        next_duration = current_duration + score_event.duration_beats
        if current_events and next_duration - beats_per_measure > MEASURE_EPSILON:
            raise ValueError(
                f"Quantized events overflow measure {measure_number}: "
                f"{next_duration} > {beats_per_measure} beats"
            )
        current_events.append(score_event)
        current_duration = next_duration
        if abs(current_duration - beats_per_measure) <= MEASURE_EPSILON:
            measures.append(Measure(number=measure_number, events=current_events))
            measure_number += 1
            current_events = []
            current_duration = 0.0

    if current_events:
        measures.append(Measure(number=measure_number, events=current_events))

    return ScoreModel(metadata=score_metadata, measures=measures)
