"""
Score data models — Pydantic v2.
Populated by parser.py on Day 2.
"""

from pydantic import BaseModel


class Note(BaseModel):
    midi: float          # MIDI note number (float preserves microtonal detail if needed)
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
