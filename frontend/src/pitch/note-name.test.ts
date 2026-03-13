import { describe, expect, it } from 'vitest';
import { midiToFrequency, midiToNoteName } from './note-name';

describe('midiToFrequency', () => {
  it('converts A4 MIDI to 440Hz', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 5);
  });
});

describe('midiToNoteName', () => {
  it('maps standard notes correctly', () => {
    expect(midiToNoteName(69)).toBe('A4');
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(55)).toBe('G3');
  });

  it('rounds fractional midi to nearest note', () => {
    expect(midiToNoteName(63.49)).toBe('D#4');
    expect(midiToNoteName(63.5)).toBe('E4');
  });
});
