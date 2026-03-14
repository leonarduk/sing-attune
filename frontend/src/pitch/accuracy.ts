import type { NoteModel } from '../score/renderer';

export type DotColor = 'green' | 'amber' | 'red' | 'grey';
export type CentsBand = 'green' | 'amber' | 'red';

export const GREEN_CENTS_THRESHOLD = 50;
export const AMBER_CENTS_THRESHOLD = 100;
export const MIN_CONFIDENCE_FOR_DOT = 0.6;
export const MIN_CONFIDENCE_FOR_SUMMARY = 0.55;

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
  return beat >= candidate.beat_start && beat < end ? candidate : null;
}

export function centsOffPitch(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

export function classifyByCents(absCents: number): CentsBand {
  if (absCents <= GREEN_CENTS_THRESHOLD) return 'green';
  if (absCents <= AMBER_CENTS_THRESHOLD) return 'amber';
  return 'red';
}

export function isWithinTolerance(absCents: number): boolean {
  return absCents <= GREEN_CENTS_THRESHOLD;
}

export function classifyPitchColor(
  sungMidi: number,
  expectedMidi: number,
  conf: number,
  confidenceThreshold = MIN_CONFIDENCE_FOR_DOT,
): DotColor {
  if (conf < confidenceThreshold) return 'grey';
  return classifyByCents(Math.abs(centsOffPitch(sungMidi, expectedMidi)));
}
