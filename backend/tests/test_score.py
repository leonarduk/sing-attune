"""
Tests for score/parser.py and score/timeline.py.
Run with: just test

Test scores (in musescore/):
  homeward_bound.mxl          — full score (Audiveris → MuseScore)
  homeward_bound-PARTI.mxl    — Part I only (MuseScore export)
  homeward_bound-PART_II.mxl  — Part II only (MuseScore export)
"""

import zipfile
from pathlib import Path

import pytest
from music21 import bar, converter, meter, note, repeat, stream

from backend.score.parser import (
    _expand_repeats,
    _get_xml_content,
    _normalize_part_name,
    parse_musicxml,
)
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

    def test_malformed_tempo_mark_fallback_xml_raises_value_error(self, tmp_path):
        """
        A .mxl that music21 parses successfully (no tempo/metronome mark) but
        whose raw-XML tempo-mark fallback (_get_xml_content + ET.fromstring
        in _extract_tempo_marks) hits a malformed entry must raise ValueError,
        not let xml.etree.ElementTree.ParseError propagate uncaught — that
        used to surface as a bare 500 from POST /score instead of a 422.

        The fixture exploits a real divergence between two "which .xml is the
        real one" heuristics operating on the same archive: music21's own
        ArchiveManager accepts a `.musicxml`-suffixed entry when picking the
        file to parse, while parser._get_xml_content only matches entries
        ending in exactly ".xml" — so, given both suffixes in one .mxl, they
        pick different members. See issue #429.
        """
        score = stream.Score()
        part = stream.Part()
        part.partName = "Test Part"
        part.append(meter.TimeSignature("4/4"))
        measure = stream.Measure(number=1)
        measure.append(note.Note("C4", quarterLength=4))
        part.append(measure)
        score.append(part)

        good_xml_path = tmp_path / "good.musicxml"
        score.write("musicxml", fp=good_xml_path)
        good_xml_text = good_xml_path.read_text(encoding="utf-8")

        mxl_path = tmp_path / "malformed_tempo.mxl"
        with zipfile.ZipFile(mxl_path, "w") as zf:
            zf.writestr(
                "META-INF/container.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<container><rootfiles><rootfile full-path="good.musicxml"/></rootfiles></container>',
            )
            # music21 accepts ".musicxml" as a candidate root file, so it parses this one.
            zf.writestr("good.musicxml", good_xml_text)
            # _get_xml_content only matches names ending in exactly ".xml", so it
            # picks this deliberately-broken sibling for the tempo-mark fallback scan.
            zf.writestr("malformed.xml", '<score-partwise><part id="P1"><note><unclosed></measure></part>')

        with pytest.raises(ValueError, match="tempo marks"):
            parse_musicxml(mxl_path)


# ---------------------------------------------------------------------------
# .mxl archive-member selection
#
# music21's own ArchiveManager._extractContents uses a suffix heuristic
# (.musicxml/.xml/.mxl, skipping META-INF) that used to be a strict superset
# of _get_xml_content's (exact ".xml" only). A single .mxl with more than one
# candidate entry could therefore make music21 parse one member while our
# raw-XML tempo-mark fallback (_extract_tempo_marks -> _get_xml_content)
# silently scanned a different one — see issue #528, and #449, which
# exploited exactly this divergence as a test fixture for issue #429.
# ---------------------------------------------------------------------------

def _build_mxl(tmp_path: Path, filename: str, entries: dict[str, str]) -> Path:
    """Build a .mxl archive at tmp_path/filename from {member_name: text} entries."""
    mxl_path = tmp_path / filename
    with zipfile.ZipFile(mxl_path, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return mxl_path


class TestGetXmlContentArchiveMemberSelection:

    def test_recognises_musicxml_suffix_like_music21(self, tmp_path):
        # ".musicxml" does not end with the literal substring ".xml", so the
        # old `name.endswith(".xml")` check missed entries like this one even
        # though music21's ArchiveManager accepts them.
        mxl_path = _build_mxl(tmp_path, "score.mxl", {
            "score.musicxml": '<sound tempo="99"/>',
        })
        assert _get_xml_content(mxl_path) == '<sound tempo="99"/>'

    def test_prefers_container_xml_rootfile_over_heuristic_first_match(self, tmp_path):
        mxl_path = _build_mxl(tmp_path, "score.mxl", {
            "META-INF/container.xml": (
                '<?xml version="1.0" encoding="UTF-8"?>'
                "<container><rootfiles>"
                '<rootfile full-path="b.xml"/>'
                "</rootfiles></container>"
            ),
            "a.xml": "<heuristic-pick/>",  # written first: what the suffix heuristic alone would pick
            "b.xml": "<container-pick/>",  # declared by container.xml: must win
        })
        assert _get_xml_content(mxl_path) == "<container-pick/>"

    def test_resolves_rootfile_when_container_xml_declares_the_ocf_namespace(self, tmp_path):
        # Real .mxl files from Finale/Sibelius etc. commonly declare the OCF
        # container namespace (MuseScore's own exports, e.g. the
        # homeward_bound fixtures, happen not to). ElementTree's "{*}"
        # wildcard tag match (stdlib since Python 3.8) is what lets
        # _resolve_container_rootfile see through that namespace instead of
        # silently falling back to the heuristic.
        mxl_path = _build_mxl(tmp_path, "score.mxl", {
            "META-INF/container.xml": (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                "<rootfiles>"
                '<rootfile full-path="real.xml" media-type="application/vnd.recordare.musicxml+xml"/>'
                "</rootfiles></container>"
            ),
            "real.xml": '<sound tempo="123"/>',
            "decoy.xml": '<sound tempo="999"/>',
        })
        assert _get_xml_content(mxl_path) == '<sound tempo="123"/>'

    def test_falls_back_to_heuristic_when_container_xml_rootfile_is_missing(self, tmp_path):
        mxl_path = _build_mxl(tmp_path, "score.mxl", {
            "META-INF/container.xml": (
                '<?xml version="1.0" encoding="UTF-8"?>'
                "<container><rootfiles>"
                '<rootfile full-path="does-not-exist.xml"/>'
                "</rootfiles></container>"
            ),
            "a.xml": "<heuristic-pick/>",
        })
        assert _get_xml_content(mxl_path) == "<heuristic-pick/>"

    def test_agrees_with_music21_archive_manager_on_multi_entry_mxl(self, tmp_path):
        """
        Reproduces the exact shape of the divergence #449 exploited: one
        .musicxml-suffixed entry and one .xml-suffixed sibling in the same
        archive, with container.xml declaring the .musicxml entry canonical.
        music21's own ArchiveManager and _get_xml_content must resolve to
        the same member.
        """
        mxl_path = _build_mxl(tmp_path, "score.mxl", {
            "META-INF/container.xml": (
                '<?xml version="1.0" encoding="UTF-8"?>'
                "<container><rootfiles>"
                '<rootfile full-path="good.musicxml"/>'
                "</rootfiles></container>"
            ),
            "good.musicxml": '<sound tempo="72"/>',
            "sibling.xml": '<sound tempo="200"/>',
        })

        music21_content = converter.ArchiveManager(mxl_path).getData(dataFormat="musicxml")
        assert _get_xml_content(mxl_path) == music21_content


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

    @pytest.mark.parametrize(
        ("directive", "expected_pitch_names"),
        [
            (
                "dc_al_fine",
                ["C4", "D4", "E4", "F4", "C4", "D4", "E4"],
            ),
            (
                "ds_al_fine",
                ["C4", "D4", "E4", "F4", "C4", "D4", "E4"],
            ),
            (
                "ds_al_coda",
                ["C4", "D4", "E4", "F4", "G4", "A4"],
            ),
        ],
    )
    def test_navigation_marks_are_expanded(self, tmp_path, directive, expected_pitch_names):
        score = stream.Score()
        part = stream.Part()
        part.partName = "Test Part"
        part.append(meter.TimeSignature("4/4"))

        for idx, pitch_name in enumerate(["C4", "D4", "E4", "F4", "G4", "A4"], start=1):
            measure = stream.Measure(number=idx)
            measure.append(note.Note(pitch_name, quarterLength=4))
            part.append(measure)

        part.measure(1).insert(0, repeat.Segno())
        part.measure(3).insert(0, repeat.Fine())

        if directive == "dc_al_fine":
            part.measure(4).insert(0, repeat.DaCapoAlFine())
        elif directive == "ds_al_fine":
            part.measure(4).insert(0, repeat.DalSegnoAlFine())
        else:
            part.measure(3).insert(0, repeat.Coda())
            part.measure(5).insert(0, repeat.Coda())
            part.measure(4).insert(0, repeat.DalSegnoAlCoda())

        score.append(part)
        path = tmp_path / f"{directive}.musicxml"
        score.write("musicxml", fp=path)

        parsed = parse_musicxml(path)
        raw_score = converter.parse(str(path))

        if directive != "ds_al_coda":
            assert len(parsed.notes) > len(raw_score.parts[0].flatten().notes)
        assert [n.midi for n in parsed.notes] == [note.Note(p).pitch.midi for p in expected_pitch_names]
        assert parsed.total_beats == pytest.approx(len(expected_pitch_names) * 4.0)

    def test_ds_al_coda_expands_when_navigation_marks_are_present(self):
        score = stream.Score()
        part = stream.Part()
        part.partName = "Test Part"
        part.append(meter.TimeSignature("4/4"))

        for idx, pitch_name in enumerate(["C4", "D4", "E4", "F4", "G4", "A4"], start=1):
            measure = stream.Measure(number=idx)
            measure.append(note.Note(pitch_name, quarterLength=4))
            part.append(measure)

        part.measure(1).insert(0, repeat.Segno())
        part.measure(3).insert(0, repeat.Coda())
        part.measure(5).insert(0, repeat.Coda())
        part.measure(4).insert(0, repeat.DalSegnoAlCoda())

        score.append(part)
        expanded = _expand_repeats(score)

        expanded_pitches = [n.pitch.nameWithOctave for n in expanded.parts[0].flatten().notes]
        assert expanded_pitches == ["C4", "D4", "E4", "F4", "C4", "D4", "E4", "G4", "A4"]
        assert expanded.duration.quarterLength == pytest.approx(36.0)


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
