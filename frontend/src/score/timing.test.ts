/**
 * Unit tests for elapsedToBeat().
 *
 * Tests the pure tempo-integration logic without any OSMD or DOM dependency.
 * Run with: npm test  (vitest)
 */
import { describe, it, expect } from 'vitest';
import { elapsedToBeat } from './timing';
import type { TempoMark } from './renderer';

// Helper: floating-point comparison with 0.001 beat tolerance (~0.8ms at 120 bpm)
const EPSILON = 0.001;
function approx(actual: number, expected: number, msg?: string): void {
  expect(Math.abs(actual - expected), msg).toBeLessThan(EPSILON);
}

const BPM60: TempoMark[] = [{ beat: 0, bpm: 60 }];  // 1000 ms per beat
const BPM120: TempoMark[] = [{ beat: 0, bpm: 120 }]; // 500 ms per beat
const BPM72: TempoMark[] = [{ beat: 0, bpm: 72 }];   // 833.33 ms per beat

describe('elapsedToBeat', () => {
  it('single tempo — zero elapsed returns 0 beats', () => {
    approx(elapsedToBeat(0, 0, BPM60), 0);
  });

  it('single tempo at 60 bpm — 1000 ms = 1 beat', () => {
    approx(elapsedToBeat(1000, 0, BPM60), 1);
  });

  it('single tempo at 120 bpm — 500 ms = 1 beat', () => {
    approx(elapsedToBeat(500, 0, BPM120), 1);
  });

  it('single tempo at 72 bpm (Homeward Bound) — 5000 ms = 6 beats', () => {
    // 72 bpm → 833.33 ms/beat; 5000 / 833.33 ≈ 6.0 beats
    approx(elapsedToBeat(5000, 0, BPM72), 6.0);
  });

  it('empty tempoMarks falls back to 120 bpm', () => {
    // 120 bpm default: 500 ms per beat
    approx(elapsedToBeat(1000, 0, []), 2);
  });

  it('tempo change — ms lands exactly on the boundary', () => {
    // 0–4 beats at 60 bpm (4000 ms), then 120 bpm after
    const marks: TempoMark[] = [
      { beat: 0, bpm: 60 },
      { beat: 4, bpm: 120 },
    ];
    // Exactly 4000 ms brings us to beat 4 (0 ms into 120 bpm segment)
    approx(elapsedToBeat(4000, 0, marks), 4);
  });

  it('tempo change — ms lands inside the first segment', () => {
    const marks: TempoMark[] = [
      { beat: 0, bpm: 60 },
      { beat: 4, bpm: 120 },
    ];
    // 2500 ms < 4000 ms (boundary) → still in 60 bpm segment
    approx(elapsedToBeat(2500, 0, marks), 2.5);
  });

  it('tempo change — ms spans across a tempo boundary', () => {
    const marks: TempoMark[] = [
      { beat: 0, bpm: 60 },   // 1000 ms/beat
      { beat: 4, bpm: 120 },  // 500 ms/beat after beat 4
    ];
    // 4000 ms to reach beat 4, then 1000 ms more at 120 bpm = 2 more beats → beat 6
    approx(elapsedToBeat(5000, 0, marks), 6);
  });

  it('startBeat mid-piece picks up the correct active tempo', () => {
    const marks: TempoMark[] = [
      { beat: 0, bpm: 60 },
      { beat: 8, bpm: 120 },
    ];
    // Starting at beat 4 (inside the 60 bpm segment): 2000 ms → 2 beats elapsed
    approx(elapsedToBeat(2000, 4, marks), 2);
  });

  it('startBeat past all tempo marks uses the last mark', () => {
    const marks: TempoMark[] = [
      { beat: 0, bpm: 60 },
      { beat: 4, bpm: 120 },
    ];
    // startBeat=16 is past the last mark (beat 4 at 120 bpm): 500 ms → 1 beat
    approx(elapsedToBeat(500, 16, marks), 1);
  });
});
