import { midiToFrequency } from './pitch/note-name';
import { type NoteModel } from './score/renderer';

export const PITCH_RANGE_MARGIN_SEMITONES = 6;

export interface PitchRange {
  minMidi: number;
  maxMidi: number;
  minFreq: number;
  maxFreq: number;
}

export function analysePartPitchRange(
  notes: NoteModel[],
  selectedPart: string,
  marginSemitones = PITCH_RANGE_MARGIN_SEMITONES,
): PitchRange | null {
  const partMidis = notes
    .filter((note) => note.part === selectedPart && Number.isFinite(note.midi))
    .map((note) => note.midi);

  if (partMidis.length === 0) return null;

  const minMidi = Math.min(...partMidis) - marginSemitones;
  const maxMidi = Math.max(...partMidis) + marginSemitones;

  return {
    minMidi,
    maxMidi,
    minFreq: midiToFrequency(minMidi),
    maxFreq: midiToFrequency(maxMidi),
  };
}
