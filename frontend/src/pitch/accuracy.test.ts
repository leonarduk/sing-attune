import { describe, expect, it } from 'vitest';
import { classifyPitchColor, expectedNoteAtBeat } from './accuracy';
import type { NoteModel } from '../score/renderer';

const notes: NoteModel[] = [
  { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'S', lyric: null },
  { midi: 62, beat_start: 1, duration: 2, measure: 1, part: 'S', lyric: null },
  { midi: 64, beat_start: 3, duration: 1, measure: 2, part: 'S', lyric: null },
];

describe('expectedNoteAtBeat', () => {
  it('returns null before first note', () => {
    expect(expectedNoteAtBeat(-0.1, notes)).toBeNull();
  });

  it('finds active note at exact start and interior beats', () => {
    expect(expectedNoteAtBeat(0, notes)?.midi).toBe(60);
    expect(expectedNoteAtBeat(1.5, notes)?.midi).toBe(62);
  });

  it('returns null in a gap or at note end boundary', () => {
    expect(expectedNoteAtBeat(4, notes)).toBeNull();
    expect(expectedNoteAtBeat(3, notes)?.midi).toBe(64);
  });
});

describe('classifyPitchColor', () => {
  it('returns grey for low confidence (conf < 0.6)', () => {
    expect(classifyPitchColor(60, 60, 0.59)).toBe('grey');
  });

  // Rest suppression is enforced by PitchOverlay.pushFrame() which checks
  // expectedNoteAtBeat() and returns early when null — classifyPitchColor
  // is never called during rests and no longer accepts null as expectedMidi.

  it('applies cents thresholds for green/amber/red', () => {
    expect(classifyPitchColor(60.49, 60, 0.8)).toBe('green');
    expect(classifyPitchColor(60.75, 60, 0.8)).toBe('amber');
    expect(classifyPitchColor(61.2, 60, 0.8)).toBe('red');
  });

  it('classifies a note exactly on the green boundary (50 cents inclusive)', () => {
    // 0.50 semitones = exactly 50 cents — boundary is inclusive for green
    expect(classifyPitchColor(60.50, 60, 0.8)).toBe('green');
  });

  it('classifies a note just inside amber (51 cents)', () => {
    // 0.51 semitones = 51 cents — just above green threshold
    expect(classifyPitchColor(60.51, 60, 0.8)).toBe('amber');
  });
});
