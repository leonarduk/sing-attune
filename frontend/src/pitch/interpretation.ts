import type { DotColor } from './accuracy';

export const MEDIAN_FILTER_FRAMES = 5;
export const ONSET_SETTLE_MS = 150;
export const GREEN_ENTRY_CENTS = 25;
export const GREEN_EXIT_CENTS = 35;

export interface InterpreterFrameInput {
  t: number;
  midi: number;
  conf: number;
  expectedMidi: number;
  expectedNoteKey: string;
  confidenceThreshold: number;
}

export interface InterpreterFrameOutput {
  filteredMidi: number;
  color: DotColor;
}

function centsError(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function noteKey(beatStart: number, midi: number, part: string): string {
  return `${part}:${beatStart}:${midi}`;
}

export class PitchInterpreter {
  private voicedMidis: number[] = [];
  private currentNoteKey: string | null = null;
  private noteOnsetMs = 0;
  private inTuneLatched = false;

  reset(): void {
    this.voicedMidis = [];
    this.currentNoteKey = null;
    this.noteOnsetMs = 0;
    this.inTuneLatched = false;
  }

  processFrame(input: InterpreterFrameInput): InterpreterFrameOutput {
    const { t, midi, conf, expectedMidi, expectedNoteKey, confidenceThreshold } = input;

    if (expectedNoteKey !== this.currentNoteKey) {
      this.currentNoteKey = expectedNoteKey;
      this.noteOnsetMs = t;
      this.inTuneLatched = false;
    }

    if (conf >= confidenceThreshold) {
      this.voicedMidis.push(midi);
      if (this.voicedMidis.length > MEDIAN_FILTER_FRAMES) this.voicedMidis.shift();
    }

    const filteredMidi = this.voicedMidis.length > 0 ? median(this.voicedMidis) : midi;

    if (conf < confidenceThreshold) {
      return { filteredMidi, color: 'grey' };
    }

    if (t - this.noteOnsetMs < ONSET_SETTLE_MS) {
      return { filteredMidi, color: 'grey' };
    }

    const absCents = Math.abs(centsError(filteredMidi, expectedMidi));
    if (this.inTuneLatched) {
      this.inTuneLatched = absCents <= GREEN_EXIT_CENTS;
    } else {
      this.inTuneLatched = absCents <= GREEN_ENTRY_CENTS;
    }

    if (this.inTuneLatched) return { filteredMidi, color: 'green' };
    if (absCents <= 100) return { filteredMidi, color: 'amber' };
    return { filteredMidi, color: 'red' };
  }
}

export function createPitchInterpreter(): PitchInterpreter {
  return new PitchInterpreter();
}
