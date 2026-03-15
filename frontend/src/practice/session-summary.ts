import { expectedNoteAtBeat } from '../pitch/accuracy';
import { midiToNoteName } from '../pitch/note-name';
import { elapsedToBeat } from '../score/timing';
import type { NoteModel, TempoMark } from '../score/renderer';

export interface PitchFrame {
  t: number;
  midi: number;
  conf: number;
}

export interface MeasureDifficulty {
  measure: number;
  avgDeviationCents: number;
}

export interface SustainedNoteSummary {
  noteName: string;
  durationMs: number;
}

export interface SessionSummary {
  lowestNote: string | null;
  highestNote: string | null;
  averagePitchDeviationCents: number | null;
  mostDifficultBars: MeasureDifficulty[];
  longestSustainedNote: SustainedNoteSummary | null;
}

interface StableRun {
  startMs: number;
  lastMs: number;
  midi: number;
}

const STABLE_MIDI_DELTA = 0.5;
const MAX_FRAME_GAP_MS = 250;
const MIN_CONFIDENCE = 0.6;

export class SessionSummaryTracker {
  private tempoMarks: TempoMark[] = [];
  private notes: NoteModel[] = [];
  private active = false;

  private minMidi: number | null = null;
  private maxMidi: number | null = null;

  private totalDeviationCents = 0;
  private deviationSamples = 0;
  private measureStats = new Map<number, { deviation: number; count: number }>();

  private stableRun: StableRun | null = null;
  private bestStableRun: StableRun | null = null;

  setContext(tempoMarks: TempoMark[], notes: NoteModel[]): void {
    this.tempoMarks = tempoMarks;
    this.notes = notes;
  }

  startSession(): void {
    this.active = true;
    this.minMidi = null;
    this.maxMidi = null;
    this.totalDeviationCents = 0;
    this.deviationSamples = 0;
    this.measureStats.clear();
    this.stableRun = null;
    this.bestStableRun = null;
  }

  reset(): void {
    this.active = false;
    this.minMidi = null;
    this.maxMidi = null;
    this.totalDeviationCents = 0;
    this.deviationSamples = 0;
    this.measureStats.clear();
    this.stableRun = null;
    this.bestStableRun = null;
  }

  recordFrame(frame: PitchFrame): void {
    if (!this.active || frame.conf < MIN_CONFIDENCE) return;

    this.minMidi = this.minMidi === null ? frame.midi : Math.min(this.minMidi, frame.midi);
    this.maxMidi = this.maxMidi === null ? frame.midi : Math.max(this.maxMidi, frame.midi);

    const beat = elapsedToBeat(frame.t, 0, this.tempoMarks);
    const expected = expectedNoteAtBeat(beat, this.notes);
    if (expected) {
      const cents = Math.abs((frame.midi - expected.midi) * 100);
      this.totalDeviationCents += cents;
      this.deviationSamples += 1;
      const stat = this.measureStats.get(expected.measure) ?? { deviation: 0, count: 0 };
      stat.deviation += cents;
      stat.count += 1;
      this.measureStats.set(expected.measure, stat);
    }

    this.updateStableRun(frame);
  }

  finishSession(): SessionSummary | null {
    if (!this.active) return null;
    this.active = false;
    this.finalizeStableRun();

    const mostDifficultBars = [...this.measureStats.entries()]
      .map(([measure, stat]) => ({
        measure,
        avgDeviationCents: stat.deviation / stat.count,
      }))
      .sort((a, b) => b.avgDeviationCents - a.avgDeviationCents || a.measure - b.measure)
      .slice(0, 3);

    return {
      lowestNote: this.minMidi === null ? null : midiToNoteName(this.minMidi),
      highestNote: this.maxMidi === null ? null : midiToNoteName(this.maxMidi),
      averagePitchDeviationCents:
        this.deviationSamples > 0 ? this.totalDeviationCents / this.deviationSamples : null,
      mostDifficultBars,
      longestSustainedNote: this.bestStableRun
        ? {
          noteName: midiToNoteName(this.bestStableRun.midi),
          durationMs: this.bestStableRun.lastMs - this.bestStableRun.startMs,
        }
        : null,
    };
  }

  private updateStableRun(frame: PitchFrame): void {
    const run = this.stableRun;
    if (!run) {
      this.stableRun = { startMs: frame.t, lastMs: frame.t, midi: frame.midi };
      return;
    }

    const gapMs = frame.t - run.lastMs;
    const stablePitch = Math.abs(frame.midi - run.midi) <= STABLE_MIDI_DELTA;
    if (gapMs <= MAX_FRAME_GAP_MS && stablePitch) {
      run.lastMs = frame.t;
      run.midi = (run.midi + frame.midi) / 2;
      return;
    }

    this.finalizeStableRun();
    this.stableRun = { startMs: frame.t, lastMs: frame.t, midi: frame.midi };
  }

  private finalizeStableRun(): void {
    if (!this.stableRun) return;
    if (!this.bestStableRun) {
      this.bestStableRun = { ...this.stableRun };
      this.stableRun = null;
      return;
    }

    const bestDuration = this.bestStableRun.lastMs - this.bestStableRun.startMs;
    const runDuration = this.stableRun.lastMs - this.stableRun.startMs;
    if (runDuration > bestDuration) {
      this.bestStableRun = { ...this.stableRun };
    }
    this.stableRun = null;
  }
}

export const sessionSummaryTracker = new SessionSummaryTracker();
