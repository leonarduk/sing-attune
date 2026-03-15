"""
Tests for score/parser.py and score/timeline.py.
Run with: just test

Test scores (in musescore/):
  homeward_bound.mxl          — full score (Audiveris → MuseScore)
  homeward_bound-PARTI.mxl    — Part I only (MuseScore export)
  homeward_bound-PART_II.mxl  — Part II only (MuseScore export)
"""

from pathlib import Path

import pytest
from music21 import converter
from music21 import bar, meter, note, stream

from backend.score.parser import _expand_repeats, _normalize_part_name, parse_musicxml
from backend.score.model import ScoreModel
from backend.score.timeline import Timeline

SCORES_DIR = Path(__file__).parent.parent.parent / "musescore"
FULL_SCORE   = SCORES_DIR / "homeward_bound.mxl"
PART_I       = SCORES_DIR / "homeward_bound-PARTI.mxl"
PART_II      = SCORES_DIR / "homeward_bound-PART_II.mxl"


class TestPartNameNormalisation:

    def test_inserts_space_for_compact_roman_numerals(self):
        assert _normalize_part_name("PARTI") == "PART I"

    def test_preserves_existing_whitespace(self):
        assert _normalize_part_name("PART II") == "PART II"

    def test_leaves_non_part_names_unchanged(self):
        assert _normalize_part_name("PIANO") == "PIANO"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _vocal_notes(score: ScoreModel):
    return [n for n in score.notes if "piano" not in n.part.lower()]


def _part_notes(score: ScoreModel, part_name: str):
    return [n for n in score.notes if n.part.upper() == part_name.upper()]


# ---------------------------------------------------------------------------
# Full score tests
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not FULL_SCORE.exists(), reason="Full score not found")
class TestParseFullScore:

    def setup_method(self):
        self.score = parse_musicxml(FULL_SCORE)

    def test_returns_score_model(self):
        assert isinstance(self.score, ScoreModel)

    def test_has_multiple_parts(self):
        assert len(self.score.parts) >= 2

    def test_notes_present(self):
        assert len(self.score.notes) > 0

    def test_valid_midi_range(self):
        for n in self.score.notes:
            assert 0 <= n.midi <= 127

    def test_positive_durations(self):
        for n in self.score.notes:
            assert n.duration > 0

    def test_lyrics_on_vocal_parts(self):
        lyrics = [n.lyric for n in _vocal_notes(self.score) if n.lyric]
        assert len(lyrics) > 0

    def test_tempo_72(self):
        assert self.score.tempo_marks[0].bpm == pytest.approx(72.0)

    def test_time_sig_3_4(self):
        ts = self.score.time_signatures[0]
        assert ts.numerator == 3
        assert ts.denominator == 4

    def test_notes_sorted_by_beat(self):
        beats = [n.beat_start for n in self.score.notes]
        assert beats == sorted(beats)


@pytest.mark.skipif(not FULL_SCORE.exists(), reason="Full score not found")
class TestHomewardBoundRealScoreCoverage:

    def setup_method(self):
        self.score = parse_musicxml(FULL_SCORE)

    def test_part_ii_initial_silence_has_no_notes_before_beat_29(self):
        part_ii = _part_notes(self.score, "PART II")
        assert part_ii, "Expected PART II notes in Homeward Bound"
        assert min(n.beat_start for n in part_ii) == pytest.approx(29.0, abs=0.5)
        assert [n for n in part_ii if n.beat_start < 29.0] == []

    def test_part_i_anacrusis_enters_at_beat_5(self):
        part_i = _part_notes(self.score, "PART I")
        assert part_i, "Expected PART I notes in Homeward Bound"
        assert part_i[0].beat_start == pytest.approx(5.0, abs=0.5)

    def test_contains_tied_note_boundaries_with_held_pitch(self):
        for part_name in ("PART I", "PART II"):
            notes = _part_notes(self.score, part_name)
            tied_boundaries = [
                (a, b)
                for a, b in zip(notes, notes[1:])
                if a.midi == b.midi and (a.beat_start + a.duration) == pytest.approx(b.beat_start)
            ]
            assert tied_boundaries, f"Expected at least one tie-like boundary in {part_name}"

    def test_repeat_expansion_does_not_shorten_score(self):
        raw_score = converter.parse(str(FULL_SCORE))
        assert self.score.total_beats >= raw_score.duration.quarterLength

    def test_part_ii_range_matches_tenor_octave_compensation_flow(self):
        part_ii_midis = [n.midi for n in _part_notes(self.score, "PART II")]
        assert min(part_ii_midis) >= 58
        assert max(part_ii_midis) <= 72


# ---------------------------------------------------------------------------
# Part I tests (MuseScore export — cleaner than Audiveris original)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not PART_I.exists(), reason="Part I file not found")
class TestParsePartI:

    def setup_method(self):
        self.score = parse_musicxml(PART_I)

    def test_single_part(self):
        assert len(self.score.parts) == 1

    def test_part_name(self):
        assert "PARTI" in self.score.parts[0].upper().replace(" ", "")

    def test_note_count_reasonable(self):
        # Full piece, should have well over 50 notes
        assert len(self.score.notes) > 50

    def test_opens_with_anacrusis(self):
        # Part I enters at beat 5 (anacrusis before first full 3/4 bar)
        first_note = self.score.notes[0]
        assert first_note.beat_start == pytest.approx(5.0, abs=0.5)

    def test_first_note_is_eb4(self):
        # "In the quiet misty morning" — first note is Eb4 = MIDI 63
        assert self.score.notes[0].midi == 63

    def test_first_lyric_is_in(self):
        assert self.score.notes[0].lyric == "In"

    def test_tempo_72(self):
        assert self.score.tempo_marks[0].bpm == pytest.approx(72.0)

    def test_time_sig_3_4(self):
        ts = self.score.time_signatures[0]
        assert ts.numerator == 3
        assert ts.denominator == 4

    def test_total_beats_about_189(self):
        assert self.score.total_beats == pytest.approx(189.5, abs=1.0)

    def test_valid_midi_range(self):
        for n in self.score.notes:
            assert 0 <= n.midi <= 127

    def test_positive_durations(self):
        for n in self.score.notes:
            assert n.duration > 0


# ---------------------------------------------------------------------------
# Part II tests
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not PART_II.exists(), reason="Part II file not found")
class TestParsePartII:

    def setup_method(self):
        self.score = parse_musicxml(PART_II)

    def test_single_part(self):
        assert len(self.score.parts) == 1

    def test_part_name(self):
        assert "II" in self.score.parts[0].upper()

    def test_enters_later_than_part_i(self):
        # Part II doesn't sing until approx beat 29
        first_note = self.score.notes[0]
        assert first_note.beat_start > 20.0

    def test_first_lyric_is_when(self):
        assert self.score.notes[0].lyric == "When"

    def test_same_duration_as_part_i(self):
        # Both parts span the full piece
        assert self.score.total_beats == pytest.approx(189.5, abs=1.0)

    def test_valid_midi_range(self):
        for n in self.score.notes:
            assert 0 <= n.midi <= 127

    def test_positive_durations(self):
        for n in self.score.notes:
            assert n.duration > 0


# ---------------------------------------------------------------------------
# Parser error handling
# ---------------------------------------------------------------------------

class TestParserErrors:

    def test_file_not_found(self):
        with pytest.raises(FileNotFoundError):
            parse_musicxml(Path("/nonexistent/score.xml"))

    def test_invalid_file(self, tmp_path):
        bad = tmp_path / "bad.xml"
        bad.write_text("this is not xml")
        with pytest.raises(ValueError):
            parse_musicxml(bad)


class TestRepeatExpansion:

    def test_repeat_barlines_are_expanded(self, tmp_path):
        score = stream.Score()
        part = stream.Part()
        part.partName = "Test Part"
        part.append(meter.TimeSignature("4/4"))

        m1 = stream.Measure(number=1)
        m1.append(note.Note("C4", quarterLength=4))

        m2 = stream.Measure(number=2)
        m2.append(note.Note("D4", quarterLength=4))
        m2.rightBarline = bar.Repeat(direction="end")

        part.append([m1, m2])
        score.append(part)

        path = tmp_path / "repeat_test.musicxml"
        score.write("musicxml", fp=path)

        parsed = parse_musicxml(path)

        assert parsed.total_beats == pytest.approx(16.0)
        assert [n.beat_start for n in parsed.notes] == pytest.approx([0.0, 4.0, 8.0, 12.0])
        assert [n.midi for n in parsed.notes] == [60, 62, 60, 62]

    def test_expand_repeats_falls_back_on_exception(self):
        score = stream.Score()

        class ExplodingScore:
            def expandRepeats(self):
                raise RuntimeError("boom")

        fallback = _expand_repeats(ExplodingScore())
        assert isinstance(fallback, ExplodingScore)

        # Sanity check: normal score still works and returns a Score-like object.
        assert _expand_repeats(score) is not None

    def test_expand_repeats_falls_back_when_return_type_is_not_score(self):
        score = stream.Score()

        class WrongTypeScore:
            def __init__(self, original):
                self.original = original

            def expandRepeats(self):
                return "not-a-score"

        wrapper = WrongTypeScore(score)
        assert _expand_repeats(wrapper) is wrapper


# ---------------------------------------------------------------------------
# Timeline tests
# ---------------------------------------------------------------------------

class TestTimeline:

    def _make_score(self, bpm: float, total_beats: float) -> ScoreModel:
        from backend.score.model import TempoMark, TimeSignature
        return ScoreModel(
            title="Test",
            parts=["Soprano"],
            notes=[],
            tempo_marks=[TempoMark(beat=0.0, bpm=bpm)],
            time_signatures=[TimeSignature(beat=0.0, numerator=3, denominator=4)],
            total_beats=total_beats,
        )

    def test_beat_to_seconds_at_60bpm(self):
        tl = Timeline(self._make_score(60.0, 16.0))
        assert tl.beat_to_seconds(0.0) == pytest.approx(0.0)
        assert tl.beat_to_seconds(1.0) == pytest.approx(1.0)
        assert tl.beat_to_seconds(4.0) == pytest.approx(4.0)

    def test_beat_to_seconds_at_120bpm(self):
        tl = Timeline(self._make_score(120.0, 16.0))
        assert tl.beat_to_seconds(1.0) == pytest.approx(0.5)
        assert tl.beat_to_seconds(4.0) == pytest.approx(2.0)

    def test_seconds_to_beat_roundtrip(self):
        tl = Timeline(self._make_score(72.0, 189.5))
        for beat in [0.0, 3.0, 12.5, 100.0, 188.0]:
            assert tl.seconds_to_beat(tl.beat_to_seconds(beat)) == pytest.approx(beat, abs=1e-6)

    def test_negative_beat_clamped(self):
        tl = Timeline(self._make_score(60.0, 16.0))
        assert tl.beat_to_seconds(-1.0) == pytest.approx(0.0)

    def test_homeward_bound_total_duration(self):
        # 189.5 beats at 72 bpm = 157.9 seconds (~2m 38s)
        tl = Timeline(self._make_score(72.0, 189.5))
        expected = 189.5 * (60.0 / 72.0)
        assert tl.total_seconds == pytest.approx(expected, rel=1e-4)

    @pytest.mark.skipif(not PART_I.exists(), reason="Part I not found")
    def test_timeline_from_real_score(self):
        score = parse_musicxml(PART_I)
        tl = Timeline(score)
        # First note at beat 5 should be ~4.17 seconds in at 72 bpm
        assert tl.beat_to_seconds(5.0) == pytest.approx(5.0 * 60.0 / 72.0, rel=1e-3)
        assert tl.total_seconds == pytest.approx(189.5 * 60.0 / 72.0, abs=1.0)
