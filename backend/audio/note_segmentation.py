"""Convert pitch frames into monophonic note events."""

from __future__ import annotations

from bisect import insort
from dataclasses import dataclass
from math import floor
from statistics import mean, median

from backend.models.transcription import NoteEvent, PitchFrame

DEFAULT_PITCH_TOLERANCE_SEMITONES = 0.75
DEFAULT_BOUNDARY_SEMITONES = 1.5
DEFAULT_MIN_NOTE_MS = 80.0
DEFAULT_MAX_GAP_MS = 60.0
DEFAULT_SMOOTHING_WINDOW = 5
DEFAULT_REQUIRED_CHANGE_FRAMES = 2


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


def _frame_step_ms(frames: list[PitchFrame]) -> float:
    if len(frames) < 2:
        return 0.0

    deltas = [
        frames[idx + 1].time_ms - frames[idx].time_ms
        for idx in range(len(frames) - 1)
        if frames[idx + 1].time_ms > frames[idx].time_ms
    ]
    return median(deltas) if deltas else 0.0


def _windowed_median(
    values: list[float],
    center_idx: int,
    radius: int,
    pitch_tolerance: float,
) -> float:
    center_value = values[center_idx]
    window = [center_value] if center_value > 0.0 else []

    stop_left = False
    stop_right = False
    for offset in range(1, radius + 1):
        left_idx = center_idx - offset
        if not stop_left and left_idx >= 0:
            value = values[left_idx]
            if value <= 0.0:
                stop_left = True
            elif abs(value - center_value) <= pitch_tolerance:
                window.append(value)

        right_idx = center_idx + offset
        if not stop_right and right_idx < len(values):
            value = values[right_idx]
            if value <= 0.0:
                stop_right = True
            elif abs(value - center_value) <= pitch_tolerance:
                window.append(value)

        if stop_left and stop_right:
            break

    return median(window) if window else 0.0


def _build_samples(frames: list[PitchFrame], frame_step_ms: float) -> list[_FrameSample]:
    samples: list[_FrameSample] = []
    for idx, frame in enumerate(frames):
        if idx > 0 and frame_step_ms > 0.0:
            previous = frames[idx - 1]
            delta_ms = frame.time_ms - previous.time_ms
            missing_frames = max(0, round(delta_ms / frame_step_ms) - 1)
            for gap_idx in range(missing_frames):
                samples.append(
                    _FrameSample(
                        time_ms=previous.time_ms + ((gap_idx + 1) * frame_step_ms),
                        midi=0.0,
                        confidence=0.0,
                        voiced=False,
                    )
                )

        samples.append(
            _FrameSample(
                time_ms=frame.time_ms,
                midi=frame.midi,
                confidence=frame.confidence,
                voiced=frame.midi > 0.0,
            )
        )

    return samples


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
        if abs(previous.midi - following.midi) > pitch_tolerance:
            continue

        fill_pitch = median([previous.midi, following.midi])
        fill_confidence = min(previous.confidence, following.confidence)
        for gap_idx in range(gap_start, gap_end):
            samples[gap_idx].voiced = True
            samples[gap_idx].midi = fill_pitch
            samples[gap_idx].confidence = fill_confidence


def _median_from_sorted(values: list[float]) -> float:
    count = len(values)
    if count == 0:
        return 0.0
    midpoint = count // 2
    if count % 2 == 1:
        return values[midpoint]
    return (values[midpoint - 1] + values[midpoint]) / 2.0


def segment_notes(
    frames: list[PitchFrame],
    config: NoteSegmentationConfig | None = None,
) -> list[NoteEvent]:
    """Collapse pitch frames into stable monophonic note events."""
    if not frames:
        return []

    cfg = config or NoteSegmentationConfig()
    frame_step_ms = _frame_step_ms(frames)
    max_gap_frames = 0
    if frame_step_ms > 0.0:
        max_gap_frames = max(0, floor(cfg.max_gap_ms / frame_step_ms))
    smoothing_radius = max(0, cfg.smoothing_window // 2)

    raw_samples = _build_samples(frames, frame_step_ms)
    _bridge_short_gaps(raw_samples, max_gap_frames, cfg.pitch_tolerance_semitones)

    voiced_midis = [sample.midi for sample in raw_samples]
    smoothed_midis = [
        _windowed_median(
            voiced_midis,
            idx,
            smoothing_radius,
            cfg.pitch_tolerance_semitones,
        )
        if sample.voiced
        else 0.0
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
        note_pitches: list[float] = []
        note_confidences: list[float] = []
        note_last_time_ms = samples[idx].time_ms
        scan_idx = idx
        change_start: int | None = None
        change_count = 0

        while scan_idx < len(samples) and samples[scan_idx].voiced:
            sample = samples[scan_idx]
            reference_pitch = _median_from_sorted(note_pitches) if note_pitches else sample.midi
            if note_pitches and abs(sample.midi - reference_pitch) >= cfg.boundary_semitones:
                change_start = scan_idx if change_start is None else change_start
                change_count += 1
                if change_count >= DEFAULT_REQUIRED_CHANGE_FRAMES:
                    break
                scan_idx += 1
                continue

            if change_start is not None:
                for pending_idx in range(change_start, scan_idx):
                    pending = samples[pending_idx]
                    insort(note_pitches, pending.midi)
                    note_confidences.append(pending.confidence)
                    note_last_time_ms = pending.time_ms
                change_start = None
                change_count = 0

            insort(note_pitches, sample.midi)
            note_confidences.append(sample.confidence)
            note_last_time_ms = sample.time_ms
            scan_idx += 1

        if change_start is not None and change_count < DEFAULT_REQUIRED_CHANGE_FRAMES:
            for pending_idx in range(change_start, scan_idx):
                pending = samples[pending_idx]
                insort(note_pitches, pending.midi)
                note_confidences.append(pending.confidence)
                note_last_time_ms = pending.time_ms
            change_start = None

        note_end = change_start if change_start is not None else scan_idx
        duration_ms = max(0.0, note_last_time_ms - samples[note_start].time_ms) + frame_step_ms
        if note_pitches and duration_ms >= cfg.min_note_ms:
            notes.append(
                NoteEvent(
                    start_time=samples[note_start].time_ms / 1000.0,
                    end_time=(note_last_time_ms + frame_step_ms) / 1000.0,
                    pitch=_median_from_sorted(note_pitches),
                    confidence=mean(note_confidences),
                )
            )

        idx = note_end if note_end > note_start else note_start + 1

    return notes
