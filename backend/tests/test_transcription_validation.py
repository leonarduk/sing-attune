"""Validation tests for transcription scenarios from issue #264."""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest
from music21 import converter, stream

from backend.audio.music_analysis import estimate_tempo
from backend.audio.note_segmentation import NoteSegmentationConfig, segment_notes
from backend.models.transcription import NoteEvent, PitchFrame
from backend.music import (
    ScoreMetadata,
    quantize_note_events,
    score_model_from_quantized_events,
    score_model_to_musicxml_string,
)
from backend.music.score_model import Measure, NoteScoreEvent, ScoreModel
from backend.transcription_service import DEFAULT_TEMPO_BPM, transcribe_audio_file

A4_MIDI = 69.0
G4_MIDI = 67.0
C4_MIDI = 60.0
D4_MIDI = 62.0
E4_MIDI = 64.0
C5_MIDI = 72.0
FRAME_STEP_MS = 20.0
SAMPLE_RATE = 22050
MAX_SHORT_GAP_MS = 40.0
SHORT_GAP_FRAMES = 3


def _hz_from_midi(midi: float) -> float:
    """Convert a MIDI note number into frequency in Hz."""

    return 440.0 * (2 ** ((midi - 69) / 12))


def _write_wav(path: Path, *, duration_seconds: float = 2.0, frequency_hz: float = 440.0) -> None:
    """Write a simple mono sine-wave WAV fixture for transcription tests."""

    assert SAMPLE_RATE == 22050
    t = np.linspace(0.0, duration_seconds, int(SAMPLE_RATE * duration_seconds), endpoint=False)
    samples = (0.3 * np.sin(2.0 * math.pi * frequency_hz * t)).astype(np.float32)
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())


def _pitch_frames(
    midis: list[float],
    *,
    confidence: float = 0.9,
    frame_step_ms: float = FRAME_STEP_MS,
) -> list[PitchFrame]:
    """Build synthetic pitch frames for segmentation-focused tests."""

    return [
        PitchFrame(
            time_ms=index * frame_step_ms,
            midi=midi,
            confidence=confidence if midi > 0.0 else 0.0,
        )
        for index, midi in enumerate(midis)
    ]


def _segment_midis(
    midis: list[float],
    *,
    confidence: float = 0.9,
    config: NoteSegmentationConfig | None = None,
) -> list[NoteEvent]:
    """Run synthetic MIDI-like pitch frames through note segmentation only."""

    return segment_notes(_pitch_frames(midis, confidence=confidence), config)


def _segmented_events_to_hz(events: list[NoteEvent]) -> list[NoteEvent]:
    """Convert segmentation output from MIDI-like pitch values into Hz-domain events."""

    return [
        NoteEvent(
            start_time=event.start_time,
            end_time=event.end_time,
            pitch=_hz_from_midi(round(event.pitch)),
            confidence=event.confidence,
        )
        for event in events
    ]


def _musicxml_note_names(
    events: list[NoteEvent],
    *,
    tempo_bpm: float = 120.0,
    time_signature: str = "4/4",
) -> list[str]:
    """Quantize/export note events and return parsed MusicXML note names."""

    quantized = quantize_note_events(events, tempo_bpm=tempo_bpm, time_signature=time_signature)
    score_model = score_model_from_quantized_events(
        quantized,
        metadata=ScoreMetadata(tempo_bpm=tempo_bpm, time_signature=time_signature),
    )
    parsed = converter.parseData(score_model_to_musicxml_string(score_model))
    return [note.nameWithOctave for note in parsed.parts[0].recurse().notes]


def test_segmentation_stage_keeps_sustained_vibrato_as_single_note() -> None:
    segmented = _segment_midis([A4_MIDI, 69.3, 68.8, 69.4, 68.9, 69.2, 68.7, 69.1, 69.0, 68.8])

    assert len(segmented) == 1
    assert segmented[0].pitch == pytest.approx(A4_MIDI, abs=0.4)


def test_sustained_vibrato_note_round_trips_as_single_readable_note() -> None:
    notes = _segmented_events_to_hz(
        _segment_midis([A4_MIDI, 69.3, 68.8, 69.4, 68.9, 69.2, 68.7, 69.1, 69.0, 68.8])
    )

    assert len(notes) == 1
    assert notes[0].pitch == pytest.approx(_hz_from_midi(69), rel=0.02)
    assert _musicxml_note_names(notes) == ["A4"]


def test_segmentation_stage_splits_repeated_notes_when_gap_exceeds_tolerance() -> None:
    segmented = _segment_midis(
        [G4_MIDI] * 5 + [0.0] * SHORT_GAP_FRAMES + [G4_MIDI] * 5,
        config=NoteSegmentationConfig(max_gap_ms=MAX_SHORT_GAP_MS, min_note_ms=60.0),
    )

    assert (SHORT_GAP_FRAMES * FRAME_STEP_MS) > MAX_SHORT_GAP_MS
    assert len(segmented) == 2
    assert segmented[0].end_time < segmented[1].start_time


def test_repeated_notes_with_short_gap_segment_into_two_attacks() -> None:
    notes = _segmented_events_to_hz(
        _segment_midis(
            [G4_MIDI] * 5 + [0.0] * SHORT_GAP_FRAMES + [G4_MIDI] * 5,
            config=NoteSegmentationConfig(max_gap_ms=MAX_SHORT_GAP_MS, min_note_ms=60.0),
        )
    )

    assert len(notes) == 2
    assert [round(69 + (12 * math.log2(note.pitch / 440.0))) for note in notes] == [67, 67]


def test_quantization_stage_inserts_leading_rest_and_splits_barline_crossing_note() -> None:
    events = [
        NoteEvent(start_time=1.5, end_time=2.5, pitch=_hz_from_midi(62), confidence=0.85),
    ]

    quantized = quantize_note_events(events, tempo_bpm=120.0, time_signature="4/4")

    rest_events = [event for event in quantized if event.event_type == "rest"]
    note_events = [event for event in quantized if event.event_type == "note"]

    assert [event.duration_beats for event in rest_events] == pytest.approx([3.0])
    assert [event.duration_beats for event in note_events] == pytest.approx([1.0, 1.0])
    assert [event.tie_start for event in note_events] == [True, False]
    assert [event.tie_stop for event in note_events] == [False, True]


def test_note_crossing_barline_quantizes_into_tied_musicxml_notes() -> None:
    events = [
        NoteEvent(start_time=1.5, end_time=2.5, pitch=_hz_from_midi(62), confidence=0.85),
    ]

    quantized = quantize_note_events(events, tempo_bpm=120.0, time_signature="4/4")
    score_model = score_model_from_quantized_events(
        quantized,
        metadata=ScoreMetadata(tempo_bpm=120.0, time_signature="4/4"),
    )
    parsed = converter.parseData(score_model_to_musicxml_string(score_model))
    parsed_notes = list(parsed.parts[0].recurse().notes)

    assert [note.tie.type for note in parsed_notes] == ["start", "stop"]


def test_export_stage_round_trips_pickup_measure_independently() -> None:
    score_model = ScoreModel(
        metadata=ScoreMetadata(tempo_bpm=96.0, time_signature="4/4"),
        measures=[
            Measure(
                number=0,
                events=[
                    NoteScoreEvent(
                        pitch="G4",
                        duration_beats=1.0,
                        source_start_time=0.0,
                        source_end_time=0.5,
                    )
                ],
            ),
            Measure(
                number=1,
                events=[
                    NoteScoreEvent(
                        pitch="C5",
                        duration_beats=4.0,
                        source_start_time=0.5,
                        source_end_time=2.5,
                    )
                ],
            ),
        ],
    )

    parsed = converter.parseData(score_model_to_musicxml_string(score_model))
    measures = parsed.parts[0].getElementsByClass(stream.Measure)

    assert [measure.number for measure in measures] == [0, 1]
    assert measures[0].barDuration.quarterLength == 4.0
    assert measures[0].notes[0].quarterLength == 1.0


def test_ambiguous_tempo_defaults_to_safe_transcription_tempo(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "single-note.wav"
    _write_wav(audio_path)

    monkeypatch.setattr(
        "backend.transcription_service._detect_pitch_frames",
        lambda _samples: _pitch_frames([C4_MIDI] * 6, confidence=0.95),
    )

    result = transcribe_audio_file(audio_path)

    assert DEFAULT_TEMPO_BPM == pytest.approx(120.0)
    assert result.tempo_bpm == pytest.approx(DEFAULT_TEMPO_BPM)
    assert f'<sound tempo="{int(DEFAULT_TEMPO_BPM)}"' in result.musicxml
    assert [note.nameWithOctave for note in converter.parseData(result.musicxml).parts[0].recurse().notes] == ["C4"]


def test_octave_error_scenario_splits_an_unexpected_octave_jump_into_two_notes() -> None:
    notes = _segmented_events_to_hz(
        _segment_midis(
            [C4_MIDI] * 6 + [C5_MIDI] * 6,
            config=NoteSegmentationConfig(min_note_ms=60.0),
        )
    )

    assert len(notes) == 2
    assert _musicxml_note_names(notes) == ["C4", "C5"]


def test_quantization_stage_preserves_low_confidence_values() -> None:
    events = [
        NoteEvent(start_time=0.0, end_time=0.5, pitch=_hz_from_midi(60), confidence=0.95),
        NoteEvent(start_time=1.0, end_time=1.5, pitch=_hz_from_midi(62), confidence=0.1),
        NoteEvent(start_time=2.0, end_time=2.5, pitch=_hz_from_midi(64), confidence=0.92),
    ]

    quantized = quantize_note_events(events, tempo_bpm=60.0)

    assert [event.confidence for event in quantized if event.event_type == "note"] == pytest.approx([0.95, 0.1, 0.92])


def test_low_confidence_pitch_region_is_preserved_and_exported() -> None:
    events = [
        NoteEvent(start_time=0.0, end_time=0.5, pitch=_hz_from_midi(60), confidence=0.95),
        NoteEvent(start_time=1.0, end_time=1.5, pitch=_hz_from_midi(62), confidence=0.1),
        NoteEvent(start_time=2.0, end_time=2.5, pitch=_hz_from_midi(64), confidence=0.92),
    ]

    assert estimate_tempo(events) == pytest.approx(60.0)
    assert _musicxml_note_names(events, tempo_bpm=60.0) == ["C4", "D4", "E4"]
