/**
 * Pure text formatting for the tenor overlay's numeric readout (#360 AC:
 * "equivalence is reported as pass/fail, not left to the eye"). Kept
 * separate from DOM wiring so the wording can be exercised without a
 * document/canvas — see tenor-overlay-compare.test.ts for the underlying
 * comparison math tests.
 */
import type { OverlayComparisonResult } from '../../pitch/tenor-overlay-compare';

export function formatOverlayReadout(
  comparison: OverlayComparisonResult,
  partName: string,
  startBar: number,
  endBar: number,
): string {
  const { bassNotes, trebleNotes } = comparison;

  if (bassNotes.length === 0 && trebleNotes.length === 0) {
    return `No notes found for "${partName}" in bars ${startBar}-${endBar}. Nothing to compare.`;
  }

  const lines: string[] = [];
  lines.push(`Bass clef notes: ${bassNotes.length} · Transposed treble notes: ${trebleNotes.length}`);

  if (!comparison.countsMatch) {
    lines.push(
      `⚠ Note counts differ by ${comparison.unpairedCount} — only the first ${comparison.deltas.length} note(s) could be paired for comparison.`,
    );
  }

  if (comparison.detectedOffsetSemitones === null) {
    lines.push('No paired notes to detect a constant offset from.');
  } else {
    const octaveNote = comparison.offsetMatchesExpectedOctave
      ? '(matches the expected one-octave displacement)'
      : '(does NOT match the expected 12-semitone/one-octave displacement)';
    lines.push(`Detected constant offset: ${comparison.detectedOffsetSemitones} semitone(s) ${octaveNote}`);
  }

  lines.push(`Mismatching notes (after removing the constant offset): ${comparison.mismatchCount}`);
  lines.push(`Equivalence: ${comparison.equivalent ? 'PASS' : 'FAIL'}`);

  return lines.join('\n');
}
