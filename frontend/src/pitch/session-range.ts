export interface SessionRange {
  lowMidi: number;
  highMidi: number;
}

export interface SessionRangeSummary extends SessionRange {
  semitoneSpan: number;
  octaveSpan: number;
}

export interface SessionRangeTrackerOptions {
  stabilityMs?: number;
  maxCentsDeviation?: number;
}

const DEFAULT_STABILITY_MS = 250;
const DEFAULT_MAX_CENTS_DEVIATION = 40;
const MIN_MIDI = 0;
const MAX_MIDI = 127;

/**
 * Tracks lowest/highest stable notes detected within a practice session.
 */
export class SessionRangeTracker {
  private readonly stabilityMs: number;
  private readonly maxCentsDeviation: number;

  private lowMidi: number | null = null;
  private highMidi: number | null = null;

  private candidateMidi: number | null = null;
  private candidateSinceMs: number | null = null;

  constructor(opts: SessionRangeTrackerOptions = {}) {
    this.stabilityMs = opts.stabilityMs ?? DEFAULT_STABILITY_MS;
    this.maxCentsDeviation = opts.maxCentsDeviation ?? DEFAULT_MAX_CENTS_DEVIATION;
  }

  ingest(frame: { t: number; midi: number; conf: number }, minConfidence: number): boolean {
    if (!Number.isFinite(frame.t) || !Number.isFinite(frame.midi) || !Number.isFinite(frame.conf)) return false;
    if (frame.t < 0 || frame.midi < MIN_MIDI || frame.midi > MAX_MIDI) {
      this.resetCandidate();
      return false;
    }
    if (frame.conf < minConfidence) {
      this.resetCandidate();
      return false;
    }

    const roundedMidi = Math.round(frame.midi);
    const centsOffset = Math.abs(frame.midi - roundedMidi) * 100;
    if (centsOffset > this.maxCentsDeviation) {
      this.resetCandidate();
      return false;
    }

    if (this.candidateMidi !== roundedMidi) {
      this.candidateMidi = roundedMidi;
      this.candidateSinceMs = frame.t;
      return false;
    }

    if (this.candidateSinceMs === null || frame.t - this.candidateSinceMs < this.stabilityMs) return false;

    return this.commitStableMidi(roundedMidi);
  }

  reset(): void {
    this.lowMidi = null;
    this.highMidi = null;
    this.resetCandidate();
  }

  hasRange(): boolean {
    return this.lowMidi !== null && this.highMidi !== null;
  }

  summary(): SessionRangeSummary | null {
    if (this.lowMidi === null || this.highMidi === null) return null;
    if (!Number.isFinite(this.lowMidi) || !Number.isFinite(this.highMidi)) return null;
    const semitoneSpan = this.highMidi - this.lowMidi;
    if (!Number.isFinite(semitoneSpan)) return null;
    return {
      lowMidi: this.lowMidi,
      highMidi: this.highMidi,
      semitoneSpan,
      octaveSpan: semitoneSpan / 12,
    };
  }

  private commitStableMidi(stableMidi: number): boolean {
    let changed = false;
    if (this.lowMidi === null || stableMidi < this.lowMidi) {
      this.lowMidi = stableMidi;
      changed = true;
    }
    if (this.highMidi === null || stableMidi > this.highMidi) {
      this.highMidi = stableMidi;
      changed = true;
    }
    return changed;
  }

  private resetCandidate(): void {
    this.candidateMidi = null;
    this.candidateSinceMs = null;
  }
}
