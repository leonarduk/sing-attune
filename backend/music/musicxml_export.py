"""MusicXML export adapter for the internal notation-domain score model."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from typing import Final

from music21 import clef, key, layout, metadata, meter, note, stream, tempo, tie
from music21.musicxml import m21ToXml

from .score_model import LyricSyllabic, NoteScoreEvent, RestScoreEvent, ScoreModel

DEFAULT_DIVISIONS: Final[int] = 4
SUPPORTED_LYRIC_SYLLABICS: Final[set[str]] = {member.value for member in LyricSyllabic}


class MusicXMLExportError(ValueError):
    """Raised when a score model cannot be represented as valid MusicXML."""


def score_model_to_music21_score(score_model: ScoreModel) -> stream.Score:
    """Convert a notation-domain ``ScoreModel`` into a ``music21`` score."""

    score = stream.Score(id="sing-attune-score")
    score.metadata = metadata.Metadata()
    score.metadata.title = "sing-attune export"

    part = stream.Part(id="P1")
    part.partName = "Voice"

    for index, measure_model in enumerate(score_model.measures):
        measure = stream.Measure(number=measure_model.number)
        if index == 0:
            measure.append(clef.TrebleClef())
            if score_model.metadata.tempo_bpm is not None:
                measure.append(tempo.MetronomeMark(number=score_model.metadata.tempo_bpm))
            measure.append(meter.TimeSignature(score_model.metadata.time_signature))
            if score_model.metadata.key_signature is not None:
                measure.append(_build_key_signature(score_model.metadata.key_signature))
            measure.append(layout.StaffLayout(staffLines=5))
        for event in measure_model.events:
            measure.append(_score_event_to_music21(event))
        part.append(measure)

    score.append(part)
    return score


def score_model_to_musicxml_bytes(score_model: ScoreModel) -> bytes:
    """Render a ``ScoreModel`` as MusicXML bytes."""

    exporter = m21ToXml.GeneralObjectExporter(score_model_to_music21_score(score_model))
    return bytes(exporter.parse())


def score_model_to_musicxml_string(score_model: ScoreModel) -> str:
    """Render a ``ScoreModel`` as a UTF-8 MusicXML string."""

    return score_model_to_musicxml_bytes(score_model).decode("utf-8")


def write_score_model_musicxml(score_model: ScoreModel, output_path: str | Path) -> Path:
    """Write a ``ScoreModel`` MusicXML document to disk and return the path."""

    path = Path(output_path)
    path.write_bytes(score_model_to_musicxml_bytes(score_model))
    return path


def _score_event_to_music21(event: NoteScoreEvent | RestScoreEvent) -> note.NotRest:
    if isinstance(event, NoteScoreEvent):
        rendered_note = note.Note(event.pitch)
        rendered_note.duration.quarterLength = _quarter_length(event.duration_beats)
        rendered_note.tie = _build_tie(event.tie_start, event.tie_stop)
        _attach_lyric(rendered_note, event.lyric_text, event.lyric_syllabic)
        return rendered_note

    rendered_rest = note.Rest()
    rendered_rest.duration.quarterLength = _quarter_length(event.duration_beats)
    return rendered_rest


def _quarter_length(duration_beats: float) -> Fraction:
    return Fraction(str(duration_beats)).limit_denominator(64)


def _build_tie(tie_start: bool, tie_stop: bool) -> tie.Tie | None:
    if tie_start and tie_stop:
        return tie.Tie("continue")
    if tie_start:
        return tie.Tie("start")
    if tie_stop:
        return tie.Tie("stop")
    return None


def _attach_lyric(
    rendered_note: note.Note,
    lyric_text: str | None,
    lyric_syllabic: LyricSyllabic | None,
) -> None:
    if lyric_text is None:
        return
    lyric = note.Lyric(text=lyric_text)
    if lyric_syllabic is not None:
        if lyric_syllabic.value not in SUPPORTED_LYRIC_SYLLABICS:
            raise MusicXMLExportError(f"Unsupported lyric syllabic value: {lyric_syllabic}")
        lyric.syllabic = lyric_syllabic.value
    rendered_note.lyrics = [lyric]


def _build_key_signature(key_signature: str) -> key.Key | key.KeySignature:
    normalized_key = key_signature.strip()

    try:
        if " " in normalized_key:
            tonic, mode = normalized_key.rsplit(" ", maxsplit=1)
            return key.Key(tonic, mode.lower())
        parsed_key = key.Key(normalized_key)
        return key.KeySignature(parsed_key.sharps)
    except Exception as exc:  # pragma: no cover - music21 raises varied exception types
        raise MusicXMLExportError(f"Unsupported key signature: {key_signature}") from exc
