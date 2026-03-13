import type { NoteModel } from '../score/renderer';

export type DotColor = 'green' | 'amber' | 'red' | 'grey';

export function expectedNoteAtBeat(beat: number, notes: NoteModel[]): NoteModel | null {
  if (notes.length === 0) return null;

  let lo = 0;
  let hi = notes.length - 1;
  let idx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].beat_start <= beat) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (idx < 0) return null;
  const candidate = notes[idx];
  const end = candidate.beat_start + candidate.duration;
  // Notes use half-open beat ranges [start, end), matching how scheduling
  // and measure boundaries are represented in the score model.
  return beat >= candidate.beat_start && beat < end ? candidate : null;
}

/**
 * Classify the dot colour for a voiced pitch frame.
 *
 * Precondition: expectedMidi is the MIDI value of the currently active note
 * (i.e. expectedNoteAtBeat() returned non-null). Callers must not invoke this
 * function during rests — use the null return from expectedNoteAtBeat() to
 * suppress the dot entirely before reaching this function.
 */
export function classifyPitchColor(
  sungMidi: number,
  expectedMidi: number,
  conf: number,
  confidenceThreshold = 0.6,
): DotColor {
  if (conf < confidenceThreshold) return 'grey';

  const cents = Math.abs((sungMidi - expectedMidi) * 100);
  if (cents <= 50) return 'green';
  if (cents <= 100) return 'amber';
  return 'red';
}
