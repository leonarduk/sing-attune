/**
 * Unit tests for PlaybackEngine timing math.
 *
 * beatToSeconds() is the inverse of elapsedToBeat() from timing.ts.
 * These tests verify correctness across single-tempo, multi-tempo, and
 * tempo-multiplier cases without requiring an AudioContext mock.
 */
import { describe, it, expect } from 'vitest';
import { beatToSeconds } from './engine';
import { elapsedToBeat } from '../score/timing';

const BPM120: import('../score/renderer').TempoMark[] = [{ beat: 0, bpm: 120 }];
const BPM60: import('../score/renderer').TempoMark[] = [{ beat: 0, bpm: 60 }];
const MULTI: import('../score/renderer').TempoMark[] = [
  { beat: 0, bpm: 120 },
  { beat: 16, bpm: 60 },
];

describe('beatToSeconds', () => {
  it('120 bpm: 2 beats → 1 second', () => {
    expect(beatToSeconds(2, BPM120)).toBeCloseTo(1.0, 6);
  });

  it('60 bpm: 1 beat → 1 second', () => {
    expect(beatToSeconds(1, BPM60)).toBeCloseTo(1.0, 6);
  });

  it('0 beats → 0 seconds', () => {
    expect(beatToSeconds(0, BPM120)).toBe(0);
  });

  it('empty tempoMarks defaults to 120 bpm', () => {
    expect(beatToSeconds(2, [])).toBeCloseTo(1.0, 6);
  });

  it('tempo multiplier 0.5 doubles duration', () => {
    // 120 bpm at 0.5× → effectively 60 bpm → 2 beats = 2 s
    expect(beatToSeconds(2, BPM120, 0.5)).toBeCloseTo(2.0, 6);
  });

  it('tempo multiplier 2 halves duration', () => {
    // 120 bpm at 2× → effectively 240 bpm → 2 beats = 0.5 s
    expect(beatToSeconds(2, BPM120, 2)).toBeCloseTo(0.5, 6);
  });

  it('multi-tempo: before tempo change', () => {
    // 0→16 at 120 bpm; beat 8 = 4 s
    expect(beatToSeconds(8, MULTI)).toBeCloseTo(4.0, 6);
  });

  it('multi-tempo: after tempo change', () => {
    // 0→16 at 120 bpm = 8 s; 16→20 at 60 bpm = 4 s; total = 12 s
    expect(beatToSeconds(20, MULTI)).toBeCloseTo(12.0, 6);
  });

  it('multi-tempo: exactly at boundary', () => {
    // beat 16 is exactly the boundary; 16 * (60/120) = 8 s
    expect(beatToSeconds(16, MULTI)).toBeCloseTo(8.0, 6);
  });
});

describe('beatToSeconds / elapsedToBeat round-trip', () => {
  const cases: Array<{ label: string; beat: number; marks: import('../score/renderer').TempoMark[]; mult: number }> = [
    { label: '120 bpm, beat 4', beat: 4, marks: BPM120, mult: 1 },
    { label: '60 bpm, beat 3', beat: 3, marks: BPM60, mult: 1 },
    { label: '120 bpm, 0.75×, beat 6', beat: 6, marks: BPM120, mult: 0.75 },
    { label: 'multi-tempo, beat 20', beat: 20, marks: MULTI, mult: 1 },
    { label: 'multi-tempo, 0.5×, beat 18', beat: 18, marks: MULTI, mult: 0.5 },
  ];

  for (const { label, beat, marks, mult } of cases) {
    it(`round-trip: ${label}`, () => {
      const scaledMarks = marks.map((m) => ({ ...m, bpm: m.bpm * mult }));
      const secs = beatToSeconds(beat, marks, mult);
      const recovered = elapsedToBeat(secs * 1000, 0, scaledMarks);
      expect(recovered).toBeCloseTo(beat, 4);
    });
  }
});
