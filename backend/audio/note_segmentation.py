"""Convert pitch frames into monophonic note events."""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean, median

from backend.models.transcription import NoteEvent, PitchFrame

DEFAULT_PITCH_TOLERANCE_SEMITONES = 0.75
DEFAULT_BOUNDARY_SEMITONES = 1.5
DEFAULT_MIN_NOTE_MS = 80.0
DEFAULT_MAX_GAP_MS = 60.0
DEFAULT_SMOOTHING_WINDOW = 5


@dataclass(frozen=True)
class NoteSegmentationConfig:
    """Heuristics controlling pitch-frame to note-event segmentation."""

    pitch_tolerance_semitones: float = DEFAULT_PITCH_TOLERANCE_SEMITONES
    boundary_semitones: float = DEFAULT_BOUNDARY_SEMITONES
    min_note_ms: float = DEFAULT_MIN_NOTE_MS
    max_gap_ms: float = DEFAULT_MAX_GAP_MS
    smoothing_window: int = DEFAULT_SMOOTHING_WINDOW


@dataclass
class _FrameSample:
    time_ms: float
    midi: float
    confidence: float
    voiced: bool


@dataclass
class _GapRun:
    start: int
    end: int


@dataclass
class _ChangeRun:
    start: int
    end: int


def _frame_step_ms(frames: list[PitchFrame]) -> float:
    if len(frames) < 2:
        return DEFAULT_MIN_NOTE_MS

    deltas = [
        frames[idx + 1].time_ms - frames[idx].time_ms
        for idx in range(len(frames) - 1)
        if frames[idx + 1].time_ms > frames[idx].time_ms
    ]
    return median(deltas) if deltas else DEFAULT_MIN_NOTE_MS


def _windowed_median(values: list[float], center_idx: int, radius: int) -> float:
    start = max(0, center_idx - radius)
    end = min(len(values), center_idx + radius + 1)
    window = [value for value in values[start:end] if value > 0.0]
    return median(window) if window else 0.0


def _bridge_short_gaps(samples: list[_FrameSample], max_gap_frames: int, pitch_tolerance: float) -> None:
    idx = 0
    while idx < len(samples):
        if samples[idx].voiced:
            idx += 1
            continue

        gap_start = idx
        while idx < len(samples) and not samples[idx].voiced:
            idx += 1
        gap_end = idx
        gap_frames = gap_end - gap_start
        if gap_frames == 0 or gap_frames > max_gap_frames:
            continue
        if gap_start == 0 or gap_end >= len(samples):
            continue

        previous = samples[gap_start - 1]
        following = samples[gap_end]
        if not previous.voiced or not following.voiced:
            continue
        if abs(previous.midi - following.midi) > pitch_tolerance:
            continue

        fill_pitch = median([previous.midi, following.midi])
        fill_confidence = min(previous.confidence, following.confidence)
        for gap_idx in range(gap_start, gap_end):
            samples[gap_idx].voiced = True
            samples[gap_idx].midi = fill_pitch
            samples[gap_idx].confidence = fill_confidence


def _find_change_run(
    samples: list[_FrameSample],
    start_idx: int,
    reference_pitch: float,
    boundary_semitones: float,
    required_frames: int,
) -> _ChangeRun | None:
    streak_start: int | None = None
    streak_count = 0

    for idx in range(start_idx, len(samples)):
        sample = samples[idx]
        if not sample.voiced:
            return None

        if abs(sample.midi - reference_pitch) >= boundary_semitones:
            streak_start = idx if streak_start is None else streak_start
            streak_count += 1
            if streak_count >= required_frames:
                return _ChangeRun(start=streak_start, end=idx + 1)
            continue

        streak_start = None
        streak_count = 0

    return None


def segment_notes(
    frames: list[PitchFrame],
    config: NoteSegmentationConfig | None = None,
) -> list[NoteEvent]:
    """Collapse pitch frames into stable monophonic note events."""
    if not frames:
        return []

    cfg = config or NoteSegmentationConfig()
    frame_step_ms = _frame_step_ms(frames)
    max_gap_frames = max(1, round(cfg.max_gap_ms / frame_step_ms))
    required_change_frames = max(1, round(cfg.min_note_ms / frame_step_ms))
    smoothing_radius = max(0, cfg.smoothing_window // 2)

    raw_samples = [
        _FrameSample(
            time_ms=frame.time_ms,
            midi=frame.midi,
            confidence=frame.confidence,
            voiced=frame.midi > 0.0,
        )
        for frame in frames
    ]
    _bridge_short_gaps(raw_samples, max_gap_frames, cfg.pitch_tolerance_semitones)

    voiced_midis = [sample.midi for sample in raw_samples]
    smoothed_midis = [
        _windowed_median(voiced_midis, idx, smoothing_radius) if sample.voiced else 0.0
        for idx, sample in enumerate(raw_samples)
    ]
    samples = [
        _FrameSample(
            time_ms=sample.time_ms,
            midi=smoothed_midis[idx] if sample.voiced else 0.0,
            confidence=sample.confidence,
            voiced=sample.voiced,
        )
        for idx, sample in enumerate(raw_samples)
    ]

    notes: list[NoteEvent] = []
    idx = 0
    while idx < len(samples):
        if not samples[idx].voiced:
            idx += 1
            continue

        note_start = idx
        note_end = idx + 1

        while note_end < len(samples) and samples[note_end].voiced:
            note_midis = [sample.midi for sample in samples[note_start:note_end] if sample.voiced]
            reference_pitch = median(note_midis)
            change_run = _find_change_run(
                samples,
                note_end,
                reference_pitch,
                cfg.boundary_semitones,
                required_change_frames,
            )
            if change_run is None:
                note_end += 1
                continue
            note_end = change_run.start
            break

        if note_end <= note_start:
            note_end = note_start + 1

        note_samples = samples[note_start:note_end]
        voiced_samples = [sample for sample in note_samples if sample.voiced]
        duration_ms = (voiced_samples[-1].time_ms - voiced_samples[0].time_ms) + frame_step_ms
        if duration_ms >= cfg.min_note_ms:
            notes.append(
                NoteEvent(
                    start_time=voiced_samples[0].time_ms / 1000.0,
                    end_time=(voiced_samples[-1].time_ms + frame_step_ms) / 1000.0,
                    pitch=median([sample.midi for sample in voiced_samples]),
                    confidence=mean(sample.confidence for sample in voiced_samples),
                )
            )

        idx = note_end if note_end > note_start else note_start + 1

    return notes
