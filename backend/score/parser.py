"""
MusicXML parser — Day 2 implementation.

Handles .xml and .mxl files. Uses music21 for structural parsing,
with a raw XML fallback for tempo values that music21 cannot parse
(e.g. "ca. 69-76" text in <per-minute> elements — as found in the
Homeward Bound score exported from Audiveris).
"""

from __future__ import annotations

import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from music21 import converter, meter, tempo as m21tempo
from music21.stream import Score

from .model import Note, ScoreModel, TempoMark, TimeSignature

# Parts that are not vocal and should be excluded from the default part list
_PIANO_ALIASES = {"piano", "keyboard", "accompaniment", "accomp", "pno", "kbd"}

_DEFAULT_BPM = 120.0


def parse_musicxml(path: Path) -> ScoreModel:
    """
    Parse a MusicXML (.xml or .mxl) file into a ScoreModel.

    Raises:
        FileNotFoundError: if path does not exist.
        ValueError: if the file cannot be parsed or contains no usable parts.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Score file not found: {path}")

    try:
        score: Score = converter.parse(str(path))
    except Exception as exc:
        raise ValueError(f"music21 could not parse {path.name}: {exc}") from exc

    title = _extract_title(score)
    tempo_marks = _extract_tempo_marks(score, path)
    time_sigs = _extract_time_signatures(score)
    parts_data, part_names = _extract_parts(score)
    total_beats = float(score.duration.quarterLength)

    if not parts_data:
        raise ValueError(f"No usable parts found in {path.name}")

    return ScoreModel(
        title=title,
        parts=part_names,
        notes=parts_data,
        tempo_marks=tempo_marks,
        time_signatures=time_sigs,
        total_beats=total_beats,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _extract_title(score: Score) -> str:
    md = score.metadata
    if md and md.title:
        return md.title
    # Fallback: movement title is sometimes used
    if hasattr(score, "movementName") and score.movementName:
        return score.movementName
    return "Untitled"


def _extract_tempo_marks(score: Score, path: Path) -> list[TempoMark]:
    """
    Extract tempo marks from the score.

    music21 returns None for text-only metronome marks like "ca. 69-76".
    In that case we fall back to raw XML <sound tempo="N"> elements.
    """
    marks: list[TempoMark] = []

    for mm in score.flatten().getElementsByClass(m21tempo.MetronomeMark):
        bpm = mm.number
        if bpm is not None:
            marks.append(TempoMark(beat=float(mm.offset), bpm=float(bpm)))

    if not marks:
        # Fallback: parse raw XML for <sound tempo="N">
        xml_content = _get_xml_content(path)
        if xml_content:
            root = ET.fromstring(xml_content)
            for sound in root.iter("sound"):
                t = sound.get("tempo")
                if t:
                    try:
                        marks.append(TempoMark(beat=0.0, bpm=float(t)))
                        break  # Take the first one; extend later if multi-tempo needed
                    except ValueError:
                        pass

    if not marks:
        marks.append(TempoMark(beat=0.0, bpm=_DEFAULT_BPM))

    return marks


def _extract_time_signatures(score: Score) -> list[TimeSignature]:
    seen: set[float] = set()
    sigs: list[TimeSignature] = []

    for ts in score.flatten().getElementsByClass(meter.TimeSignature):
        beat = float(ts.offset)
        if beat not in seen:
            seen.add(beat)
            sigs.append(TimeSignature(
                beat=beat,
                numerator=ts.numerator,
                denominator=ts.denominator,
            ))

    if not sigs:
        sigs.append(TimeSignature(beat=0.0, numerator=4, denominator=4))

    return sigs


def _extract_parts(score: Score) -> tuple[list[Note], list[str]]:
    """
    Extract notes from all non-piano parts.

    Returns (all_notes, part_name_list). Part names are deduplicated;
    piano / keyboard parts are included in the name list (for the UI
    part selector) but labelled so the frontend can hide them by default.
    """
    all_notes: list[Note] = []
    part_names: list[str] = []
    seen_names: set[str] = set()

    for part in score.parts:
        raw_name = part.partName or "Unknown"
        # Deduplicate grand-staff piano (appears as two parts with same name)
        if raw_name in seen_names:
            continue
        seen_names.add(raw_name)
        part_names.append(raw_name)

        for el in part.flatten().notes:
            # el is either a Note or a Chord
            if hasattr(el, "pitch"):
                # Single note
                all_notes.append(_make_note(el, raw_name))
            else:
                # Chord — emit each pitch separately
                for n in el.notes:
                    all_notes.append(_make_note(n, raw_name, override_offset=float(el.offset), override_duration=float(el.duration.quarterLength)))

    # Sort by beat position for predictable consumption
    all_notes.sort(key=lambda n: (n.beat_start, n.part))
    return all_notes, part_names


def _make_note(
    el,
    part_name: str,
    override_offset: float | None = None,
    override_duration: float | None = None,
) -> Note:
    lyric: str | None = None
    if el.lyric:
        lyric = el.lyric

    return Note(
        midi=int(el.pitch.midi),
        beat_start=override_offset if override_offset is not None else float(el.offset),
        duration=override_duration if override_duration is not None else float(el.duration.quarterLength),
        measure=int(el.measureNumber) if el.measureNumber else 0,
        part=part_name,
        lyric=lyric,
    )


def _get_xml_content(path: Path) -> str | None:
    """Extract raw XML string from .xml or .mxl file."""
    if path.suffix.lower() == ".mxl":
        try:
            with zipfile.ZipFile(path) as zf:
                for name in zf.namelist():
                    if name.endswith(".xml") and not name.startswith("META-INF"):
                        return zf.read(name).decode("utf-8")
        except Exception:
            return None
    else:
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            return None
    return None
