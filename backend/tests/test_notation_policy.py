"""Tests for centralized transcription notation policy."""

from fractions import Fraction

from backend.music.notation_policy import (
    CrossBarNotePolicy,
    DottedVsTiedPolicy,
    NotationPolicy,
    V1_NOTATION_POLICY,
)


class TestNotationPolicyDefaults:
    def test_v1_defaults_match_issue_spec(self):
        assert V1_NOTATION_POLICY.max_subdivision == Fraction(1, 16)
        assert V1_NOTATION_POLICY.allowed_durations_beats == (4.0, 2.0, 1.0, 0.5, 0.25)
        assert V1_NOTATION_POLICY.cross_bar_notes == CrossBarNotePolicy.SPLIT_AND_TIE
        assert V1_NOTATION_POLICY.default_clef == "treble"
        assert V1_NOTATION_POLICY.default_time_signature == "4/4"

    def test_is_allowed_duration(self):
        assert V1_NOTATION_POLICY.is_allowed_duration(1.0)
        assert not V1_NOTATION_POLICY.is_allowed_duration(0.75)

    def test_small_gap_merging_uses_threshold(self):
        assert V1_NOTATION_POLICY.should_merge_small_gap(0.01)
        assert not V1_NOTATION_POLICY.should_merge_small_gap(0.05)

    def test_dotted_vs_tied_rule_is_explicit(self):
        assert (
            V1_NOTATION_POLICY.dotted_vs_tied_policy
            == DottedVsTiedPolicy.PREFER_DOTTED_WITHIN_BEAT
        )


class TestNotationPolicyCustomValues:
    def test_custom_allowed_durations_affect_lookup(self):
        policy = NotationPolicy(allowed_durations_beats=(2.0, 1.0, 0.5))

        assert policy.is_allowed_duration(0.5)
        assert not policy.is_allowed_duration(0.25)
