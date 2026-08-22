/**
 * Comparison logic for the tenor bass-clef / transposed-treble overlay
 * debug view (#360).
 *
 * Tenor parts are conventionally notated two equivalent ways:
 *   - Bass clef: written at actual sounding pitch.
 *   - Transposed treble: written on a treble clef, displaced up by an
 *     octave (the common convention so tenors can read a treble-clef part),
 *     which must sound the same as the bass-clef version once the octave
 *     displacement is undone.
 *
 * This module is deliberately pure (no DOM/canvas) so the comparison math
 * can be unit tested independently of rendering — see
 * backend/tests/test_score.py::test_part_ii_range_matches_tenor_octave_compensation_flow
 * for the equivalent backend-side numeric invariant this view visualises,
 * and frontend/src/services/audio-preflight.ts (octaveCompensation) for the
 * runtime setting this same convention already drives.
 */

/** Minimal note shape this comparison needs — a subset of score/renderer.ts's NoteModel. */
export interface OverlayNote {
  midi: number;
  beat_start: number;
  measure: number;
}

/** Per-note-pair comparison result, indexed by position within the shorter sequence. */
export interface NoteDelta {
  index: number;
  bassMidi: number;
  trebleMidi: number;
  /** trebleMidi - bassMidi, in semitones. */
  semitoneDelta: number;
  /** Whether this note's delta matches the detected constant offset. */
  matchesOffset: boolean;
}

export interface OverlayComparisonResult {
  bassNotes: OverlayNote[];
  trebleNotes: OverlayNote[];
  /** One entry per paired note (i.e. up to min(bassNotes.length, trebleNotes.length)). */
  deltas: NoteDelta[];
  /**
   * The most common semitone delta across paired notes, or null when there
   * are no paired notes to compare. Expected value for a true tenor
   * bass/treble pair is 12 (one octave) — see EXPECTED_OCTAVE_OFFSET.
   */
  detectedOffsetSemitones: number | null;
  /** Whether the detected offset equals the expected one-octave (12 semitone) displacement. */
  offsetMatchesExpectedOctave: boolean;
  /** Count of paired notes whose delta differs from the detected constant offset. */
  mismatchCount: number;
  /** Notes present in one sequence but not the other (|bassNotes.length - trebleNotes.length|). */
  unpairedCount: number;
  /** True when both sequences have the same note count. */
  countsMatch: boolean;
  /**
   * Explicit pass/fail equivalence verdict — per #360 AC, equivalence must
   * be reported as pass/fail, not left for a human to eyeball off the graph.
   * Passes only when both sequences are non-empty, note counts match, every
   * paired note agrees with the single detected constant offset, AND that
   * offset is the expected one-octave displacement.
   *
   * That last condition is deliberate, not merely internal-consistency
   * checking: #360's purpose is validating that a bass-clef part and its
   * transposed-treble counterpart are the SAME tenor music, which requires
   * the octave displacement specifically. Two sequences that are constant
   * apart by, say, 7 semitones are "internally consistent" but are not a
   * valid bass/transposed-treble pair, and reporting PASS for them would
   * contradict the readout's own "does NOT match the expected octave"
   * message (see PR #407 review, finding H2).
   */
  equivalent: boolean;
}

/** Expected constant offset between bass-clef and transposed-treble tenor notation: one octave. */
export const EXPECTED_OCTAVE_OFFSET_SEMITONES = 12;

/**
 * Filters a flat note list down to one part's notes within an inclusive bar
 * (measure) range. Returns [] (never throws) when the part or range has no
 * notes — degenerate-case handling required by #360 AC.
 */
export function filterNotesInBarRange<T extends OverlayNote & { part: string }>(
  notes: T[],
  partName: string,
  startBar: number,
  endBar: number,
): T[] {
  const normalizedPart = partName.trim().toUpperCase();
  return notes.filter(
    (note) =>
      note.part.trim().toUpperCase() === normalizedPart &&
      note.measure >= startBar &&
      note.measure <= endBar,
  );
}

/**
 * Derives the "transposed treble" note sequence from a bass-clef sequence by
 * applying a constant semitone offset (default: one octave up). This is the
 * synthetic counterpart used when only one real notation exists to check
 * against — see module docstring.
 */
export function deriveOffsetNotes<T extends OverlayNote>(
  notes: T[],
  offsetSemitones: number = EXPECTED_OCTAVE_OFFSET_SEMITONES,
): OverlayNote[] {
  return notes.map((note) => ({
    ...note,
    midi: note.midi + offsetSemitones,
  }));
}

/**
 * Applies a deliberate single-note error to a derived note sequence, at the
 * given index, by adding `semitones` on top of whatever offset that note
 * already carries.
 *
 * Exists because `deriveOffsetNotes` applies one constant offset to every
 * note, which means `compareTenorVersions` always detects that same offset
 * and always reports PASS on the live debug page — the comparison logic is
 * exercised by a genuine mismatch in tenor-overlay-compare.test.ts, but the
 * page itself had no way to *demonstrate* the FAIL/mismatch-highlight path
 * (see PR #407 review, finding H1). This lets the debug page's "perturb
 * note" control inject one wrong note into the derived series so a human
 * can actually see mismatch markers and a FAIL verdict on real UI, not just
 * in a unit test.
 *
 * No-op (returns a shallow copy) when `index` is out of range, so callers
 * can wire this straight to a user-typed index without bounds-checking
 * first.
 */
export function perturbNoteAt<T extends OverlayNote>(notes: T[], index: number, semitones: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= notes.length || semitones === 0) {
    return [...notes];
  }
  return notes.map((note, i) => (i === index ? { ...note, midi: note.midi + semitones } : note));
}

function mostCommonDelta(deltas: number[]): number | null {
  if (deltas.length === 0) return null;

  const counts = new Map<number, number>();
  for (const delta of deltas) {
    counts.set(delta, (counts.get(delta) ?? 0) + 1);
  }

  let best: number | null = null;
  let bestCount = -1;
  for (const [delta, count] of counts) {
    // Tie-break deterministically: prefer higher count, then the value
    // closest to the expected one-octave offset, then the smallest value.
    const better =
      count > bestCount ||
      (count === bestCount &&
        best !== null &&
        Math.abs(delta - EXPECTED_OCTAVE_OFFSET_SEMITONES) < Math.abs(best - EXPECTED_OCTAVE_OFFSET_SEMITONES)) ||
      (count === bestCount &&
        best !== null &&
        Math.abs(delta - EXPECTED_OCTAVE_OFFSET_SEMITONES) === Math.abs(best - EXPECTED_OCTAVE_OFFSET_SEMITONES) &&
        delta < best);
    if (better) {
      best = delta;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Compares a bass-clef note sequence against a transposed-treble note
 * sequence and reports the per-note deltas plus a pass/fail equivalence
 * verdict. Never throws — handles empty input and mismatched lengths per
 * #360 AC.
 *
 * Unequal lengths: the first min(bass, treble) notes are paired positionally
 * and the surplus tail is left unpaired — it is reported via unpairedCount
 * and fails `equivalent` through countsMatch, but is deliberately NOT added
 * to mismatchCount, which counts only paired notes whose delta disagrees
 * with the detected offset. Kept separate so the readout can distinguish
 * "these notes disagree" from "one version has notes the other lacks".
 */
export function compareTenorVersions(
  bassNotes: OverlayNote[],
  trebleNotes: OverlayNote[],
): OverlayComparisonResult {
  const pairCount = Math.min(bassNotes.length, trebleNotes.length);
  const rawDeltas: number[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    rawDeltas.push(trebleNotes[i].midi - bassNotes[i].midi);
  }

  const detectedOffsetSemitones = mostCommonDelta(rawDeltas);

  const deltas: NoteDelta[] = rawDeltas.map((semitoneDelta, index) => ({
    index,
    bassMidi: bassNotes[index].midi,
    trebleMidi: trebleNotes[index].midi,
    semitoneDelta,
    matchesOffset: detectedOffsetSemitones !== null && semitoneDelta === detectedOffsetSemitones,
  }));

  const mismatchCount = deltas.filter((d) => !d.matchesOffset).length;
  const unpairedCount = Math.abs(bassNotes.length - trebleNotes.length);
  const countsMatch = bassNotes.length === trebleNotes.length;
  const offsetMatchesExpectedOctave = detectedOffsetSemitones === EXPECTED_OCTAVE_OFFSET_SEMITONES;

  const equivalent =
    bassNotes.length > 0 &&
    trebleNotes.length > 0 &&
    countsMatch &&
    mismatchCount === 0 &&
    detectedOffsetSemitones !== null &&
    offsetMatchesExpectedOctave;

  return {
    bassNotes,
    trebleNotes,
    deltas,
    detectedOffsetSemitones,
    offsetMatchesExpectedOctave,
    mismatchCount,
    unpairedCount,
    countsMatch,
    equivalent,
  };
}
