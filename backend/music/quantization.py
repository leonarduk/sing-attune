"""Duration quantization from acoustic note events into notation candidates."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Final, Sequence

from backend.models.transcription import NoteEvent

from .notation_policy import NotationPolicy, V1_NOTATION_POLICY
from .score_model import QuantizedEvent

DEFAULT_TEMPO_BPM: Final[float] = 120.0
_GRID_EPSILON: Final[float] = 1e-9


@dataclass(frozen=True)
class _BeatSpan:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def quantize_note_events(
    events: Sequence[NoteEvent],
    tempo_bpm: float | None = None,
    time_signature: str | None = None,
    notation_policy: NotationPolicy = V1_NOTATION_POLICY,
) -> list[QuantizedEvent]:
    """Convert acoustic-domain note events into notation-ready quantized events."""

    if not events:
        return []

    seconds_per_beat = 60.0 / _validated_tempo(tempo_bpm)
    beats_per_measure = _beats_per_measure(time_signature or notation_policy.default_time_signature)
    grid_step = float(notation_policy.max_subdivision)
    quantized: list[QuantizedEvent] = []
    previous_end_beat = 0.0

    for event in events:
        start_beat = _quantize_to_grid(event.start_time / seconds_per_beat, grid_step)
        end_beat = _quantize_to_grid(event.end_time / seconds_per_beat, grid_step)
        if end_beat <= start_beat:
            end_beat = start_beat + grid_step

        if start_beat - previous_end_beat > _GRID_EPSILON:
            quantized.extend(
                _build_rest_events(
                    previous_end_beat,
                    start_beat,
                    seconds_per_beat=seconds_per_beat,
                    beats_per_measure=beats_per_measure,
                    notation_policy=notation_policy,
                )
            )

        quantized.extend(
            _build_note_events(
                event,
                start_beat,
                end_beat,
                seconds_per_beat=seconds_per_beat,
                beats_per_measure=beats_per_measure,
                notation_policy=notation_policy,
            )
        )
        previous_end_beat = end_beat

    return quantized


def _build_rest_events(
    start_beat: float,
    end_beat: float,
    *,
    seconds_per_beat: float,
    beats_per_measure: float,
    notation_policy: NotationPolicy,
) -> list[QuantizedEvent]:
    return [
        QuantizedEvent(
            event_type="rest",
            duration_beats=span.duration,
            source_start_time=span.start * seconds_per_beat,
            source_end_time=span.end * seconds_per_beat,
        )
        for span in _decompose_across_bars_and_beats(
            start_beat,
            end_beat,
            beats_per_measure=beats_per_measure,
            notation_policy=notation_policy,
        )
    ]


def _build_note_events(
    event: NoteEvent,
    start_beat: float,
    end_beat: float,
    *,
    seconds_per_beat: float,
    beats_per_measure: float,
    notation_policy: NotationPolicy,
) -> list[QuantizedEvent]:
    spans = _decompose_across_bars_and_beats(
        start_beat,
        end_beat,
        beats_per_measure=beats_per_measure,
        notation_policy=notation_policy,
    )
    pitch = _midi_to_pitch_name(event.pitch)
    quantized: list[QuantizedEvent] = []

    for index, span in enumerate(spans):
        source_start_time = max(event.start_time, span.start * seconds_per_beat)
        source_end_time = min(event.end_time, span.end * seconds_per_beat)
        quantized.append(
            QuantizedEvent(
                event_type="note",
                pitch=pitch,
                duration_beats=span.duration,
                source_start_time=source_start_time,
                source_end_time=max(source_start_time, source_end_time),
                confidence=event.confidence,
                tie_stop=index > 0,
                tie_start=index < (len(spans) - 1),
            )
        )

    return quantized


def _decompose_across_bars_and_beats(
    start_beat: float,
    end_beat: float,
    *,
    beats_per_measure: float,
    notation_policy: NotationPolicy,
) -> list[_BeatSpan]:
    spans: list[_BeatSpan] = []
    cursor = start_beat

    while end_beat - cursor > _GRID_EPSILON:
        measure_end = (math.floor(cursor / beats_per_measure) + 1) * beats_per_measure
        bounded_end = min(end_beat, measure_end)
        spans.extend(
            _decompose_measure_local_span(
                cursor,
                bounded_end,
                notation_policy=notation_policy,
            )
        )
        cursor = bounded_end

    return spans


def _decompose_measure_local_span(
    start_beat: float,
    end_beat: float,
    *,
    notation_policy: NotationPolicy,
) -> list[_BeatSpan]:
    spans: list[_BeatSpan] = []
    cursor = start_beat

    while end_beat - cursor > _GRID_EPSILON:
        remaining = end_beat - cursor
        duration = _choose_duration(cursor, remaining, notation_policy)
        spans.append(_BeatSpan(start=cursor, end=cursor + duration))
        cursor += duration

    return spans


def _choose_duration(cursor: float, remaining: float, notation_policy: NotationPolicy) -> float:
    candidates = _candidate_durations(notation_policy)
    beat_offset = cursor % 1.0

    for duration in candidates:
        if duration - remaining > _GRID_EPSILON:
            continue
        if _is_readable_choice(beat_offset, duration):
            return duration

    grid_step = float(notation_policy.max_subdivision)
    return min(remaining, grid_step)


def _candidate_durations(notation_policy: NotationPolicy) -> tuple[float, ...]:
    base = set(notation_policy.allowed_durations_beats)
    base.update({3.0, 1.5, 0.75})
    return tuple(sorted(base, reverse=True))


def _is_readable_choice(beat_offset: float, duration: float) -> bool:
    normalized_offset = round(beat_offset, 8)
    if duration in {4.0, 3.0, 2.0, 1.0, 0.5, 0.25}:
        return True
    if duration == 1.5:
        return math.isclose(normalized_offset, 0.0, abs_tol=1e-8)
    if duration == 0.75:
        return math.isclose(normalized_offset, 0.0, abs_tol=1e-8) or math.isclose(
            normalized_offset, 0.5, abs_tol=1e-8
        )
    return False


def _validated_tempo(tempo_bpm: float | None) -> float:
    tempo = DEFAULT_TEMPO_BPM if tempo_bpm is None else float(tempo_bpm)
    if tempo <= 0:
        raise ValueError("tempo_bpm must be positive")
    return tempo


def _beats_per_measure(time_signature: str) -> float:
    numerator_text, denominator_text = time_signature.split("/", maxsplit=1)
    numerator = int(numerator_text)
    denominator = int(denominator_text)
    if numerator <= 0 or denominator <= 0:
        raise ValueError("time_signature must use positive numerator and denominator")
    return numerator * (4 / denominator)


def _quantize_to_grid(value: float, grid_step: float) -> float:
    return round(value / grid_step) * grid_step


def _midi_to_pitch_name(frequency_hz: float) -> str:
    if not math.isfinite(frequency_hz) or frequency_hz <= 0.0:
        raise ValueError("Detected note pitch must be positive")
    midi_number = round(69 + (12 * math.log2(frequency_hz / 440.0)))
    pitch_classes = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    octave = (midi_number // 12) - 1
    pitch_class = pitch_classes[midi_number % 12]
    return f"{pitch_class}{octave}"
