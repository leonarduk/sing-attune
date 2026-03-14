export interface DiagnosticFrame {
  t: number;
  midi: number;
  conf: number;
}

export interface DiagnosticState {
  noteName: string;
  cents: number;
  confidence: number;
  stable: boolean;
  heldMs: number;
  activeMidi: number;
}

const STABLE_FRAMES_REQUIRED = 4;
const STABLE_CENTS_LIMIT = 40;

export function midiToCentsOffset(midi: number): number {
  return (midi - Math.round(midi)) * 100;
}

export class StablePitchTracker {
  private lastRoundedMidi: number | null = null;
  private runLength = 0;
  private heldStartMs: number | null = null;

  reset(): void {
    this.lastRoundedMidi = null;
    this.runLength = 0;
    this.heldStartMs = null;
  }

  push(frame: DiagnosticFrame, confidenceThreshold: number): DiagnosticState {
    const rounded = Math.round(frame.midi);
    const cents = midiToCentsOffset(frame.midi);
    const confidenceOk = frame.conf >= confidenceThreshold;
    const centsOk = Math.abs(cents) <= STABLE_CENTS_LIMIT;

    if (!confidenceOk || !centsOk) {
      this.lastRoundedMidi = null;
      this.runLength = 0;
      this.heldStartMs = null;
      return {
        noteName: '',
        cents,
        confidence: frame.conf,
        stable: false,
        heldMs: 0,
        activeMidi: rounded,
      };
    }

    if (this.lastRoundedMidi === rounded) {
      this.runLength += 1;
    } else {
      this.lastRoundedMidi = rounded;
      this.runLength = 1;
      this.heldStartMs = frame.t;
    }

    const stable = this.runLength >= STABLE_FRAMES_REQUIRED;
    const heldMs = this.heldStartMs === null ? 0 : Math.max(0, frame.t - this.heldStartMs);

    return {
      noteName: '',
      cents,
      confidence: frame.conf,
      stable,
      heldMs,
      activeMidi: rounded,
    };
  }
}
