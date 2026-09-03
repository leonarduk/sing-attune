import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  MAX_CONFIDENCE_THRESHOLD,
  MAX_TRAIL_MS,
  MIN_TRAIL_MS,
  normalizeOverlaySettings,
  sortedNotesForPart,
} from './overlay';
import { expectedNoteAtBeat } from './accuracy';
import type { NoteModel } from '../score/renderer';

describe('normalizeOverlaySettings', () => {
  it('clamps confidence and trail values to supported ranges', () => {
    expect(normalizeOverlaySettings({
      confidenceThreshold: 0.1,
      trailMs: 50,
    })).toEqual({
      confidenceThreshold: 0.1,
      trailMs: MIN_TRAIL_MS,
    });

    expect(normalizeOverlaySettings({
      confidenceThreshold: 1.5,
      trailMs: 15000,
    })).toEqual({
      confidenceThreshold: MAX_CONFIDENCE_THRESHOLD,
      trailMs: MAX_TRAIL_MS,
    });
  });

  it('uses fallback defaults for non-finite values', () => {
    expect(normalizeOverlaySettings({
      confidenceThreshold: Number.NaN,
      trailMs: Number.POSITIVE_INFINITY,
    })).toEqual({
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      trailMs: 2000,
    });
  });
});

describe('sortedNotesForPart', () => {
  // Deliberately out of beat_start order and interleaved with another part,
  // mirroring how ScoreModel.notes can arrive from the backend (issue #434).
  // Also includes a same-beat chord pair (midi 64 & 65 both at beat 3) to
  // confirm sorting doesn't require unique beat_start values.
  const rawNotes: NoteModel[] = [
    { midi: 64, beat_start: 3, duration: 1, measure: 2, part: 'S', lyric: null },
    { midi: 67, beat_start: 1, duration: 2, measure: 1, part: 'A', lyric: null },
    { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'S', lyric: null },
    { midi: 65, beat_start: 3, duration: 1, measure: 2, part: 'S', lyric: null },
    { midi: 62, beat_start: 1, duration: 2, measure: 1, part: 'S', lyric: null },
  ];

  it('filters to the requested part and sorts ascending by beat_start', () => {
    const result = sortedNotesForPart(rawNotes, 'S');
    expect(result.every((n) => n.part === 'S')).toBe(true);
    expect(result.map((n) => n.beat_start)).toEqual([0, 1, 3, 3]);
  });

  it('lets expectedNoteAtBeat resolve correctly once setPart-equivalent output is sorted', () => {
    const sorted = sortedNotesForPart(rawNotes, 'S');
    expect(expectedNoteAtBeat(0, sorted)?.midi).toBe(60);
    expect(expectedNoteAtBeat(1.5, sorted)?.midi).toBe(62);
    // Either chord note is an acceptable resolution at beat 3 — the point is
    // that a valid note is found at all (not null, per the bug below).
    expect([64, 65]).toContain(expectedNoteAtBeat(3, sorted)?.midi);
  });

  it('regression: a plain filter (pre-fix setPart behaviour) breaks the binary search', () => {
    // This reproduces overlay.ts's old `.filter()`-only setPart(), which
    // preserved document order instead of beat_start order.
    const filterOnly = rawNotes.filter((n) => n.part === 'S');
    // The unsorted array violates expectedNoteAtBeat's ascending-order
    // assumption, so the binary search silently returns null for beats
    // that do have an active note — exactly the mis-coloured-dot bug
    // described in issue #434.
    expect(expectedNoteAtBeat(1.5, filterOnly)).toBeNull();
    expect(expectedNoteAtBeat(3, filterOnly)).toBeNull();
  });
});
