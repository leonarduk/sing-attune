import { describe, expect, it } from 'vitest';
import { PitchTimelineSync } from './timeline-sync';

describe('PitchTimelineSync', () => {
  it('maps frame times to audio clock and back using the active anchor', () => {
    const sync = new PitchTimelineSync();
    sync.reanchor(1000, 10);

    expect(sync.frameToAudioTime(1250)).toBeCloseTo(10.25, 6);
    expect(sync.audioToFrameTime(10.75)).toBeCloseTo(1750, 6);
  });

  it('supports re-anchoring for resume/seek transitions', () => {
    const sync = new PitchTimelineSync();
    sync.reanchor(0, 5);
    expect(sync.frameToAudioTime(500)).toBeCloseTo(5.5, 6);

    sync.reanchor(850, 15.2);
    expect(sync.frameToAudioTime(900)).toBeCloseTo(15.25, 6);
    expect(sync.audioToFrameTime(15.7)).toBeCloseTo(1350, 6);
  });

  it('marks stale frames relative to the visible window', () => {
    const sync = new PitchTimelineSync();
    sync.reanchor(2000, 20);

    expect(sync.isFrameStale(3200, 23.0, 1000)).toBe(true);
    expect(sync.isFrameStale(4200, 23.0, 1000)).toBe(false);
  });

  it('returns null when unanchored', () => {
    const sync = new PitchTimelineSync();
    expect(sync.frameToAudioTime(100)).toBeNull();
    expect(sync.audioToFrameTime(1.2)).toBeNull();
    expect(sync.isFrameStale(100, 1.2, 500)).toBe(false);
  });
});
