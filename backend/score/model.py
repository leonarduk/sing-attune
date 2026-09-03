"""
Score data models — Pydantic v2.
Populated by parser.py on Day 2.
"""

from pydantic import BaseModel


class Note(BaseModel):
    # MIDI note number. In practice this is always a whole-semitone value today:
    # the only producer (parser._make_note) does midi=int(el.pitch.midi), and
    # music21's Pitch.midi accessor itself always rounds to the nearest integer
    # semitone — even for pitches carrying microtonal accidentals (e.g. quarter
    # tones) — since fractional precision in music21 lives on Pitch.ps, not
    # Pitch.midi. So there is no microtonal data available to preserve at the
    # point parser.py reads el.pitch.midi; dropping the int() cast there would
    # not restore any precision. Field kept as `float` (not `int`) for schema
    # flexibility, in case a future parser change sources microtonal data from
    # Pitch.ps instead. See issue #431.
    midi: float
    beat_start: float    # Quarter-note beats from start of piece
    duration: float      # Duration in quarter-note beats
    measure: int
    part: str            # Part name e.g. "Soprano", "Tenor"
    lyric: str | None = None


class TempoMark(BaseModel):
    beat: float          # Beat position where this tempo applies
    bpm: float


class TimeSignature(BaseModel):
    beat: float          # Beat position where this time sig applies
    numerator: int
    denominator: int


class ScoreModel(BaseModel):
    title: str
    parts: list[str]
    notes: list[Note]
    tempo_marks: list[TempoMark]
    time_signatures: list[TimeSignature]
    total_beats: float
