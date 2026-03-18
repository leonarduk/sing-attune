"""Validation tests for transcription scenarios from issue #264."""

from __future__ import annotations

from pathlib import Path

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
from backend.transcription_service import DEFAULT_TEMPO_BPM, TranscriptionResult, transcribe_audio_file


FRAME_STEP_MS = 20.0


def _hz_from_midi(midi: int) -> float:
    return 440.0 * (2 ** ((midi - 69) / 12))


def _frames(midis: list[float], *, confidence: float = 0.9, frame_step_ms: float = FRAME_STEP_MS) -> list[PitchFrame]:
    return [
        PitchFrame(
            time_ms=index * frame_step_ms,
            midi=midi,
            confidence=confidence if midi > 0.0 else 0.0,
        )
        for index, midi in enumerate(midis)
    ]


def _normalize_events(events: list[NoteEvent]) -> list[NoteEvent]:
    normalized: list[NoteEvent] = []
    for event in events:
        pitch = event.pitch
        if pitch <= 127.0:
            pitch = _hz_from_midi(round(pitch))
        normalized.append(
            NoteEvent(
                start_time=event.start_time,
                end_time=event.end_time,
                pitch=pitch,
                confidence=event.confidence,
            )
        )
    return normalized


def _export_note_names(events: list[NoteEvent], *, tempo_bpm: float = 120.0, time_signature: str = "4/4") -> list[str]:
    quantized = quantize_note_events(_normalize_events(events), tempo_bpm=tempo_bpm, time_signature=time_signature)
    score_model = score_model_from_quantized_events(
        quantized,
        metadata=ScoreMetadata(tempo_bpm=tempo_bpm, time_signature=time_signature),
    )
    parsed = converter.parseData(score_model_to_musicxml_string(score_model))
    return [note.nameWithOctave for note in parsed.parts[0].recurse().notes]


def test_sustained_vibrato_note_round_trips_as_single_readable_note() -> None:
    frames = _frames([69.0, 69.3, 68.8, 69.4, 68.9, 69.2, 68.7, 69.1, 69.0, 68.8])

    notes = segment_notes(frames)

    assert len(notes) == 1
    assert notes[0].pitch == pytest.approx(69.0, abs=0.4)
    assert _export_note_names(notes) == ["A4"]


def test_repeated_notes_with_short_gap_segment_into_two_attacks() -> None:
    frames = _frames([67.0] * 5 + [0.0] * 4 + [67.0] * 5)

    notes = segment_notes(
        frames,
        NoteSegmentationConfig(max_gap_ms=40.0, min_note_ms=60.0),
    )

    assert len(notes) == 2
    assert [round(note.pitch) for note in notes] == [67, 67]
    assert notes[0].end_time < notes[1].start_time


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

    assert [event.duration_beats for event in quantized] == pytest.approx([3.0, 1.0, 1.0])
    assert [event.tie_start for event in quantized if event.event_type == "note"] == [True, False]
    assert [event.tie_stop for event in quantized if event.event_type == "note"] == [False, True]
    assert [note.tie.type for note in parsed_notes] == ["start", "stop"]


def test_pickup_measure_exports_as_anacrusis_that_music21_can_load() -> None:
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
    audio_path.write_bytes(b"RIFF0000WAVEfmt ")

    monkeypatch.setattr("backend.transcription_service._load_wav_mono", lambda _path: [0.0] * 4096)
    monkeypatch.setattr(
        "backend.transcription_service._detect_pitch_frames",
        lambda _samples: _frames([60.0] * 6, confidence=0.95),
    )

    result = transcribe_audio_file(audio_path)

    assert isinstance(result, TranscriptionResult)
    assert result.tempo_bpm == DEFAULT_TEMPO_BPM
    assert "<sound tempo=\"120\"" in result.musicxml


def test_octave_error_scenario_is_split_into_separate_notation_notes() -> None:
    frames = _frames([60.0] * 6 + [72.0] * 6)

    notes = segment_notes(frames, NoteSegmentationConfig(min_note_ms=60.0))

    assert len(notes) == 2
    assert _export_note_names(notes) == ["C4", "C5"]


def test_low_confidence_pitch_region_is_preserved_and_downweighted_in_tempo_analysis() -> None:
    events = [
        NoteEvent(start_time=0.0, end_time=0.5, pitch=_hz_from_midi(60), confidence=0.95),
        NoteEvent(start_time=1.0, end_time=1.5, pitch=_hz_from_midi(62), confidence=0.1),
        NoteEvent(start_time=2.0, end_time=2.5, pitch=_hz_from_midi(64), confidence=0.92),
    ]

    quantized = quantize_note_events(events, tempo_bpm=60.0)
    note_confidences = [event.confidence for event in quantized if event.event_type == "note"]

    assert estimate_tempo(events) == pytest.approx(60.0)
    assert note_confidences == pytest.approx([0.95, 0.1, 0.92])
    assert _export_note_names(events, tempo_bpm=60.0) == ["C4", "D4", "E4"]
