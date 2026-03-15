import type { PitchFrame } from './socket';

export interface StableNoteSettings {
  minConfidence: number;
  clusteringToleranceCents: number;
  holdDurationMs: number;
  smoothingWindowMs: number;
}

interface WindowFrame {
  t: number;
  midi: number;
}

interface Cluster {
  count: number;
  sumMidi: number;
  firstT: number;
  lastT: number;
}

export interface StableNoteState {
  rawMidi: number;
  stableMidi: number | null;
}

export const DEFAULT_STABLE_NOTE_SETTINGS: StableNoteSettings = {
  minConfidence: 0.6,
  clusteringToleranceCents: 35,
  holdDurationMs: 160,
  smoothingWindowMs: 320,
};

function normalizeSettings(settings: StableNoteSettings): StableNoteSettings {
  return {
    minConfidence: Math.min(0.99, Math.max(0, settings.minConfidence)),
    clusteringToleranceCents: Math.min(200, Math.max(5, settings.clusteringToleranceCents)),
    holdDurationMs: Math.min(2000, Math.max(20, settings.holdDurationMs)),
    smoothingWindowMs: Math.min(4000, Math.max(40, settings.smoothingWindowMs)),
  };
}

export class StableNoteDetector {
  private settings: StableNoteSettings;
  private windowFrames: WindowFrame[] = [];
  private candidateMidi: number | null = null;
  private candidateStartMs: number | null = null;
  private stableMidi: number | null = null;

  constructor(settings: StableNoteSettings = DEFAULT_STABLE_NOTE_SETTINGS) {
    this.settings = normalizeSettings(settings);
  }

  applySettings(settings: StableNoteSettings): void {
    this.settings = normalizeSettings(settings);
    this.pruneWindow(this.windowFrames.at(-1)?.t ?? 0);
  }

  reset(): void {
    this.windowFrames = [];
    this.candidateMidi = null;
    this.candidateStartMs = null;
    this.stableMidi = null;
  }

  pushFrame(frame: PitchFrame): StableNoteState {
    if (frame.conf >= this.settings.minConfidence) {
      this.windowFrames.push({ t: frame.t, midi: frame.midi });
    }

    this.pruneWindow(frame.t);
    const dominant = this.dominantCluster();

    if (dominant === null) {
      this.candidateMidi = null;
      this.candidateStartMs = null;
      this.stableMidi = null;
      return { rawMidi: frame.midi, stableMidi: null };
    }

    const centroid = dominant.sumMidi / dominant.count;

    if (this.candidateMidi === null || !this.withinTolerance(centroid, this.candidateMidi)) {
      // New dominant cluster — use the earliest frame in that cluster as the
      // candidate start time so that hold duration is measured from when the
      // cluster first appeared in the window, not from the current frame.
      this.candidateMidi = centroid;
      this.candidateStartMs = dominant.firstT;
    }

    if (this.candidateStartMs !== null && this.candidateMidi !== null) {
      const holdMs = frame.t - this.candidateStartMs;
      if (holdMs >= this.settings.holdDurationMs) {
        this.stableMidi = this.candidateMidi;
      }
    }

    return { rawMidi: frame.midi, stableMidi: this.stableMidi };
  }

  private pruneWindow(nowMs: number): void {
    const cutoff = nowMs - this.settings.smoothingWindowMs;
    this.windowFrames = this.windowFrames.filter((frame) => frame.t >= cutoff);
  }

  /**
   * Returns the highest-count cluster in the current window (ties broken by
   * most recently updated), including its first and last frame timestamps.
   *
   * `firstT` is used as `candidateStartMs` so that hold duration is measured
   * from when the dominant cluster first appeared in the window — not from
   * the moment it became dominant. This prevents a subtle bug where a cluster
   * that accumulated frames over time would reset its hold timer to the
   * current frame when it finally became dominant.
   */
  private dominantCluster(): Cluster | null {
    if (this.windowFrames.length === 0) return null;

    const clusters: Cluster[] = [];
    for (const frame of this.windowFrames) {
      let matched = false;
      for (const cluster of clusters) {
        const centroid = cluster.sumMidi / cluster.count;
        if (this.withinTolerance(frame.midi, centroid)) {
          cluster.count += 1;
          cluster.sumMidi += frame.midi;
          cluster.lastT = frame.t;
          matched = true;
          break;
        }
      }
      if (!matched) {
        clusters.push({ count: 1, sumMidi: frame.midi, firstT: frame.t, lastT: frame.t });
      }
    }

    let best: Cluster | null = null;
    for (const cluster of clusters) {
      if (!best || cluster.count > best.count || (cluster.count === best.count && cluster.lastT > best.lastT)) {
        best = cluster;
      }
    }
    return best ?? null;
  }

  private withinTolerance(aMidi: number, bMidi: number): boolean {
    const toleranceSemitones = this.settings.clusteringToleranceCents / 100;
    return Math.abs(aMidi - bMidi) <= toleranceSemitones;
  }
}
