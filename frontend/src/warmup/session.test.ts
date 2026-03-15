import { describe, expect, it } from 'vitest';
import { buildWarmupSequence, warmupMidiAt } from './session';

describe('warmup sequence', () => {
  it('covers the full configured warmup duration', () => {
    const sequence = buildWarmupSequence(120, 60);
    expect(sequence.length).toBeGreaterThan(10);
    expect(sequence[0]?.startMs).toBe(0);
    const last = sequence.at(-1);
    expect(last?.endMs).toBe(120000);
  });

  it('respects minimum and maximum duration clamps', () => {
    const shortSeq = buildWarmupSequence(5, 60);
    const longSeq = buildWarmupSequence(1000, 60);
    expect(shortSeq.at(-1)?.endMs).toBe(30000);
    expect(longSeq.at(-1)?.endMs).toBe(300000);
  });

  it('returns current target midi based on elapsed time', () => {
    const sequence = buildWarmupSequence(60, 60);
    expect(warmupMidiAt(0, sequence)).not.toBeNull();
    expect(warmupMidiAt(59999, sequence)).not.toBeNull();
    expect(warmupMidiAt(60000, sequence)).toBeNull();
  });
});
