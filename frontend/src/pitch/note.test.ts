import { describe, expect, it } from 'vitest';
import { midiToFrequencyHz, midiToNoteName } from './note';

describe('midiToFrequencyHz', () => {
  it('maps A4 (69) to 440 Hz', () => {
    expect(midiToFrequencyHz(69)).toBeCloseTo(440, 6);
  });

  it('maps C4 (60) to 261.63 Hz', () => {
    expect(midiToFrequencyHz(60)).toBeCloseTo(261.63, 2);
  });
});

describe('midiToNoteName', () => {
  it('converts core reference notes', () => {
    expect(midiToNoteName(69)).toBe('A4');
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(52)).toBe('E3');
    expect(midiToNoteName(55)).toBe('G3');
  });

  it('rounds fractional midi values to nearest note', () => {
    expect(midiToNoteName(68.51)).toBe('A4');
    expect(midiToNoteName(68.49)).toBe('G#4');
  });
});
