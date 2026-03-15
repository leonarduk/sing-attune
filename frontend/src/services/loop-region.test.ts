import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoopRegion,
  getLoopRegion,
  onLoopRegionChanged,
  setLoopEnd,
  setLoopStart,
} from './loop-region';

describe('loop-region', () => {
  beforeEach(() => {
    clearLoopRegion();
  });

  it('activates a region once both start and end are set in order', () => {
    setLoopStart(8);
    setLoopEnd(16);

    expect(getLoopRegion()).toEqual({
      startBeat: 8,
      endBeat: 16,
      active: true,
    });
  });

  it('keeps region inactive when end is before or equal to start', () => {
    setLoopStart(12);
    setLoopEnd(10);

    expect(getLoopRegion()).toEqual({
      startBeat: 12,
      endBeat: 10,
      active: false,
    });
  });

  it('notifies listeners on updates', () => {
    const listener = vi.fn();
    const unsubscribe = onLoopRegionChanged(listener);

    setLoopStart(2);
    setLoopEnd(6);
    clearLoopRegion();

    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
