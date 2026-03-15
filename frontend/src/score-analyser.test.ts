import { describe, expect, it } from 'vitest';
import { analysePartPitchRange, PITCH_RANGE_MARGIN_SEMITONES } from './score-analyser';

describe('analysePartPitchRange', () => {
  it('returns null when selected part has no notes', () => {
    const range = analysePartPitchRange([
      { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'Soprano', lyric: null },
    ], 'Alto');

    expect(range).toBeNull();
  });

  it('computes min/max midi with ±6 semitone margin and frequency bounds', () => {
    const range = analysePartPitchRange([
      { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'Alto', lyric: null },
      { midi: 67, beat_start: 1, duration: 1, measure: 1, part: 'Alto', lyric: null },
      { midi: 72, beat_start: 2, duration: 1, measure: 2, part: 'Soprano', lyric: null },
    ], 'Alto');

    expect(range).not.toBeNull();
    expect(range?.minMidi).toBe(60 - PITCH_RANGE_MARGIN_SEMITONES);
    expect(range?.maxMidi).toBe(67 + PITCH_RANGE_MARGIN_SEMITONES);
    expect(range?.minFreq).toBeLessThan(range?.maxFreq ?? 0);
  });
});
