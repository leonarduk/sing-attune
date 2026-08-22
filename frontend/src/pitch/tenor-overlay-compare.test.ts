import { describe, expect, it } from 'vitest';
import {
  compareTenorVersions,
  deriveOffsetNotes,
  EXPECTED_OCTAVE_OFFSET_SEMITONES,
  filterNotesInBarRange,
  perturbNoteAt,
  type OverlayNote,
} from './tenor-overlay-compare';

function note(midi: number, measure: number, beat_start = measure * 4): OverlayNote {
  return { midi, measure, beat_start };
}

describe('filterNotesInBarRange', () => {
  const notes = [
    { midi: 60, measure: 1, beat_start: 0, part: 'Tenor' },
    { midi: 62, measure: 2, beat_start: 4, part: 'Tenor' },
    { midi: 64, measure: 5, beat_start: 16, part: 'Tenor' },
    { midi: 67, measure: 2, beat_start: 4, part: 'Soprano' },
  ];

  it('filters by part name (case-insensitive) and inclusive bar range', () => {
    const result = filterNotesInBarRange(notes, 'tenor', 1, 2);
    expect(result.map((n) => n.midi)).toEqual([60, 62]);
  });

  it('returns an empty array without throwing when the bar range has no notes', () => {
    expect(filterNotesInBarRange(notes, 'Tenor', 100, 200)).toEqual([]);
  });

  it('returns an empty array without throwing when the part name has no notes', () => {
    expect(filterNotesInBarRange(notes, 'Bass', 1, 10)).toEqual([]);
  });
});

describe('deriveOffsetNotes', () => {
  it('defaults to a one-octave (12 semitone) upward shift', () => {
    const bass = [note(60, 1), note(62, 1)];
    const treble = deriveOffsetNotes(bass);
    expect(treble.map((n) => n.midi)).toEqual([72, 74]);
  });

  it('supports an arbitrary offset for exploring non-equivalent cases', () => {
    const bass = [note(60, 1)];
    const treble = deriveOffsetNotes(bass, 7);
    expect(treble[0].midi).toBe(67);
  });
});

describe('compareTenorVersions — constant-offset detection', () => {
  it('detects a consistent one-octave offset and reports equivalence as pass', () => {
    const bass = [note(60, 1), note(62, 1), note(64, 2)];
    const treble = deriveOffsetNotes(bass);
    const result = compareTenorVersions(bass, treble);

    expect(result.detectedOffsetSemitones).toBe(EXPECTED_OCTAVE_OFFSET_SEMITONES);
    expect(result.offsetMatchesExpectedOctave).toBe(true);
    expect(result.mismatchCount).toBe(0);
    expect(result.countsMatch).toBe(true);
    expect(result.equivalent).toBe(true);
  });

  it('detects a non-octave constant offset and flags it as not matching the expected octave', () => {
    const bass = [note(60, 1), note(62, 1)];
    const treble = deriveOffsetNotes(bass, 7);
    const result = compareTenorVersions(bass, treble);

    expect(result.detectedOffsetSemitones).toBe(7);
    expect(result.offsetMatchesExpectedOctave).toBe(false);
    // Internally consistent (every note shares the same delta) is NOT
    // enough for `equivalent` — #360's purpose is validating a genuine
    // bass-clef/transposed-treble tenor pair, which requires the offset to
    // be the expected octave specifically (PR #407 review, finding H2).
    expect(result.equivalent).toBe(false);
  });
});

describe('compareTenorVersions — mismatch counting', () => {
  it('counts notes whose delta does not match the dominant constant offset', () => {
    const bass = [note(60, 1), note(62, 1), note(64, 2), note(65, 2)];
    const treble = [note(72, 1), note(74, 1), note(77, 2), note(77, 2)]; // third note is off by 13, not 12
    const result = compareTenorVersions(bass, treble);

    expect(result.detectedOffsetSemitones).toBe(12);
    expect(result.mismatchCount).toBe(1);
    expect(result.equivalent).toBe(false);
    expect(result.deltas[2].matchesOffset).toBe(false);
    expect(result.deltas[3].matchesOffset).toBe(true);
  });

  it('fails equivalence when the offset is internally consistent but not the expected octave', () => {
    const bass = [note(60, 1)];
    const treble = [note(61, 1)];
    const result = compareTenorVersions(bass, treble);

    // A single paired note is trivially internally consistent (one delta is
    // always "the" constant offset) — but `equivalent` also requires that
    // offset to match the expected octave, so this must still be a FAIL
    // (PR #407 review, finding H2).
    expect(typeof result.equivalent).toBe('boolean');
    expect(result.equivalent).toBe(false);
    expect(result.offsetMatchesExpectedOctave).toBe(false);
  });
});

describe('perturbNoteAt', () => {
  it('adds the given semitones to only the note at the given index', () => {
    const bass = [note(60, 1), note(62, 1), note(64, 2)];
    const treble = deriveOffsetNotes(bass);
    const perturbed = perturbNoteAt(treble, 1, 3);

    expect(perturbed.map((n) => n.midi)).toEqual([72, 77, 76]);
  });

  it('is a no-op copy for an out-of-range index', () => {
    const bass = [note(60, 1)];
    const treble = deriveOffsetNotes(bass);

    expect(perturbNoteAt(treble, 5, 3)).toEqual(treble);
    expect(perturbNoteAt(treble, -1, 3)).toEqual(treble);
  });

  it('is a no-op for a zero-semitone perturbation', () => {
    const bass = [note(60, 1), note(62, 1)];
    const treble = deriveOffsetNotes(bass);

    expect(perturbNoteAt(treble, 0, 0)).toEqual(treble);
  });

  it('feeds a live perturbation into compareTenorVersions and produces a real, demonstrable FAIL', () => {
    // This is the H1 fix from the PR #407 review: without a perturbation
    // control, the debug page could only ever show PASS because the
    // treble series was always derived by a single constant offset from
    // the bass series. Perturbing one note reproduces, on the live page,
    // the same kind of genuine mismatch tenor-overlay-compare.test.ts
    // already covers in isolation above.
    const bass = [note(60, 1), note(62, 1), note(64, 2), note(65, 2)];
    const treble = deriveOffsetNotes(bass);
    const perturbedTreble = perturbNoteAt(treble, 2, 1);
    const result = compareTenorVersions(bass, perturbedTreble);

    expect(result.detectedOffsetSemitones).toBe(12);
    expect(result.mismatchCount).toBe(1);
    expect(result.deltas[2].matchesOffset).toBe(false);
    expect(result.equivalent).toBe(false);
  });
});

describe('compareTenorVersions — empty and unequal-length inputs', () => {
  it('handles two empty sequences without throwing', () => {
    const result = compareTenorVersions([], []);
    expect(result.deltas).toEqual([]);
    expect(result.detectedOffsetSemitones).toBeNull();
    expect(result.mismatchCount).toBe(0);
    expect(result.unpairedCount).toBe(0);
    expect(result.countsMatch).toBe(true);
    expect(result.equivalent).toBe(false); // nothing to compare is not a pass
  });

  it('handles an empty bass sequence against a non-empty treble sequence', () => {
    const result = compareTenorVersions([], [note(72, 1)]);
    expect(result.deltas).toEqual([]);
    expect(result.unpairedCount).toBe(1);
    expect(result.countsMatch).toBe(false);
    expect(result.equivalent).toBe(false);
  });

  it('handles differing note counts by pairing the shorter length and counting the rest as unpaired', () => {
    const bass = [note(60, 1), note(62, 1), note(64, 2)];
    const treble = deriveOffsetNotes(bass.slice(0, 2)); // treble is missing the third note
    const result = compareTenorVersions(bass, treble);

    expect(result.deltas).toHaveLength(2);
    expect(result.unpairedCount).toBe(1);
    expect(result.countsMatch).toBe(false);
    expect(result.equivalent).toBe(false); // count mismatch alone fails equivalence
  });
});
