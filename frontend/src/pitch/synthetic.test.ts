import { describe, expect, it } from 'vitest';
import { syntheticPitchFrameAt } from './synthetic';

describe('syntheticPitchFrameAt', () => {
  it('is deterministic for a given timestamp and target', () => {
    const a = syntheticPitchFrameAt(12.5, 64);
    const b = syntheticPitchFrameAt(12.5, 64);
    expect(a).toEqual(b);
  });

  it('uses target-follow behavior when expected midi is present', () => {
    const frame = syntheticPitchFrameAt(4.2, 62);
    expect(frame.midi).toBeGreaterThan(62);
    expect(frame.midi).toBeLessThan(63);
    expect(frame.conf).toBe(0.95);
  });


  it('uses explicit frame timestamp when provided', () => {
    const frame = syntheticPitchFrameAt(4.2, 62, 9876);
    expect(frame.t).toBe(9876);
  });

  it('falls back to sweep when no expected midi exists', () => {
    const frame = syntheticPitchFrameAt(7, null);
    expect(frame.midi).toBeGreaterThan(48);
    expect(frame.midi).toBeLessThan(73);
  });
});
