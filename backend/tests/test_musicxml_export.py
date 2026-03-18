"""Tests for MusicXML export from the internal score model."""

from __future__ import annotations

from pathlib import Path

import pytest
from music21 import converter, note, stream

from backend.music.musicxml_export import (
    MusicXMLExportError,
    score_model_to_music21_score,
    score_model_to_musicxml_string,
    write_score_model_musicxml,
)
from backend.music.score_model import (
    LyricSyllabic,
    Measure,
    NoteScoreEvent,
    RestScoreEvent,
    ScoreMetadata,
    ScoreModel,
)


class TestMusicXMLExport:
    def test_converts_score_model_to_music21_score(self):
        model = ScoreModel(
            metadata=ScoreMetadata(tempo_bpm=92, key_signature="D", time_signature="3/4"),
            measures=[
                Measure(
                    number=1,
                    events=[
                        NoteScoreEvent(
                            pitch="C4",
                            duration_beats=1.0,
                            source_start_time=0.0,
                            source_end_time=0.5,
                            lyric_text="Hal",
                            lyric_syllabic=LyricSyllabic.BEGIN,
                        ),
                        NoteScoreEvent(
                            pitch="C4",
                            duration_beats=0.5,
                            source_start_time=0.5,
                            source_end_time=0.75,
                            tie_start=True,
                        ),
                        RestScoreEvent(
                            duration_beats=1.5,
                            source_start_time=0.75,
                            source_end_time=1.5,
                        ),
                    ],
                ),
                Measure(
                    number=2,
                    events=[
                        NoteScoreEvent(
                            pitch="C4",
                            duration_beats=0.5,
                            source_start_time=1.5,
                            source_end_time=1.75,
                            tie_stop=True,
                            lyric_text="lo",
                            lyric_syllabic=LyricSyllabic.END,
                        ),
                        NoteScoreEvent(
                            pitch="E4",
                            duration_beats=2.5,
                            source_start_time=1.75,
                            source_end_time=3.0,
                            confidence=0.95,
                        ),
                    ],
                ),
            ],
        )

        exported_score = score_model_to_music21_score(model)

        part = exported_score.parts[0]
        measures = part.getElementsByClass(stream.Measure)
        assert len(measures) == 2
        assert measures[0].number == 1
        assert measures[1].number == 2

        first_measure_notes = measures[0].notesAndRests
        assert first_measure_notes[0].quarterLength == 1.0
        assert first_measure_notes[0].lyric == "Hal"
        assert first_measure_notes[0].lyrics[0].syllabic == "begin"
        assert first_measure_notes[1].tie.type == "start"
        assert first_measure_notes[2].isRest

        second_measure_notes = measures[1].notesAndRests
        assert second_measure_notes[0].tie.type == "stop"
        assert second_measure_notes[0].lyrics[0].syllabic == "end"
        assert second_measure_notes[1].quarterLength == 2.5

    def test_renders_musicxml_that_round_trips_through_music21(self):
        model = ScoreModel(
            metadata=ScoreMetadata(tempo_bpm=88, key_signature="Bb", time_signature="4/4"),
            measures=[
                Measure(
                    number=1,
                    events=[
                        NoteScoreEvent(
                            pitch="D4",
                            duration_beats=1.0,
                            source_start_time=0.0,
                            source_end_time=0.5,
                            lyric_text="Twin",
                            lyric_syllabic=LyricSyllabic.SINGLE,
                        ),
                        RestScoreEvent(
                            duration_beats=1.0,
                            source_start_time=0.5,
                            source_end_time=1.0,
                        ),
                        NoteScoreEvent(
                            pitch="F4",
                            duration_beats=2.0,
                            source_start_time=1.0,
                            source_end_time=2.0,
                        ),
                    ],
                )
            ],
        )

        musicxml = score_model_to_musicxml_string(model)

        assert "<time>" in musicxml
        assert "<beats>4</beats>" in musicxml
        assert "<beat-type>4</beat-type>" in musicxml
        assert "<rest" in musicxml
        assert "<lyric" in musicxml
        assert "<syllabic>single</syllabic>" in musicxml

        parsed = converter.parseData(musicxml)
        parsed_notes = list(parsed.recurse().getElementsByClass(note.Note))
        assert parsed_notes[0].lyric == "Twin"
        assert parsed_notes[0].lyrics[0].syllabic == "single"

    def test_writes_musicxml_file(self, tmp_path: Path):
        model = ScoreModel(
            metadata=ScoreMetadata(),
            measures=[
                Measure(
                    number=1,
                    events=[
                        NoteScoreEvent(
                            pitch="C4",
                            duration_beats=4.0,
                            source_start_time=0.0,
                            source_end_time=2.0,
                        )
                    ],
                )
            ],
        )

        output_path = write_score_model_musicxml(model, tmp_path / "export.musicxml")

        assert output_path.exists()
        assert output_path.read_text(encoding="utf-8").startswith("<?xml")

    def test_rejects_unsupported_key_signature(self):
        model = ScoreModel(
            metadata=ScoreMetadata(key_signature="definitely-not-a-key"),
            measures=[
                Measure(
                    number=1,
                    events=[
                        NoteScoreEvent(
                            pitch="C4",
                            duration_beats=4.0,
                            source_start_time=0.0,
                            source_end_time=1.0,
                        )
                    ],
                )
            ],
        )

        with pytest.raises(MusicXMLExportError, match="Unsupported key signature"):
            score_model_to_music21_score(model)
