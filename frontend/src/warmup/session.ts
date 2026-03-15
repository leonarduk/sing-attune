import { midiToFrequency } from '../pitch/note-name';
import { getAudioContext } from '../services/audio-context';

export interface WarmupSegment {
  exercise: 'sirens' | 'sustain' | 'scale' | 'range';
  startMs: number;
  endMs: number;
  midi: number;
  label: string;
}

export function buildWarmupSequence(totalSeconds: number, anchorMidi = 60): WarmupSegment[] {
  const clampedSeconds = Math.max(30, Math.min(300, totalSeconds));
  const totalMs = clampedSeconds * 1000;
  const phaseMs = totalMs / 4;
  const segments: WarmupSegment[] = [];

  const appendPattern = (
    exercise: WarmupSegment['exercise'],
    startMs: number,
    durationMs: number,
    pattern: number[],
    holdMs: number,
  ): void => {
    let t = startMs;
    let i = 0;
    while (t < startMs + durationMs) {
      const midi = pattern[i % pattern.length] ?? anchorMidi;
      const endMs = Math.min(startMs + durationMs, t + holdMs);
      segments.push({
        exercise,
        startMs: t,
        endMs,
        midi,
        label: `${exercise}: ${midi}`,
      });
      t = endMs;
      i += 1;
    }
  };

  appendPattern('sirens', 0, phaseMs, [anchorMidi - 5, anchorMidi, anchorMidi + 5, anchorMidi + 12, anchorMidi + 5, anchorMidi], 800);
  appendPattern('sustain', phaseMs, phaseMs, [anchorMidi - 2, anchorMidi + 2, anchorMidi + 4], 3000);
  appendPattern('scale', phaseMs * 2, phaseMs, [anchorMidi, anchorMidi + 2, anchorMidi + 4, anchorMidi + 5, anchorMidi + 7, anchorMidi + 5, anchorMidi + 4, anchorMidi + 2], 650);
  appendPattern('range', phaseMs * 3, phaseMs, [anchorMidi - 4, anchorMidi - 2, anchorMidi, anchorMidi + 2, anchorMidi + 4, anchorMidi + 2, anchorMidi], 1000);

  return segments;
}

export function warmupMidiAt(elapsedMs: number, sequence: WarmupSegment[]): number | null {
  const seg = sequence.find((s) => elapsedMs >= s.startMs && elapsedMs < s.endMs);
  return seg?.midi ?? null;
}

export class WarmupTonePlayer {
  private lastMidi: number | null = null;
  private lastPlayedAt = 0;

  playExpectedMidi(midi: number | null): void {
    if (midi === null) return;
    const now = performance.now();
    if (this.lastMidi === midi && (now - this.lastPlayedAt) < 450) return;

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const t0 = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFrequency(midi);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);

    this.lastMidi = midi;
    this.lastPlayedAt = now;
  }
}
