import { describe, expect, it } from 'vitest';
import { StablePitchTracker, midiToCentsOffset } from './diagnostics';

describe('midiToCentsOffset', () => {
  it('returns cents offset from nearest semitone', () => {
    expect(midiToCentsOffset(69.0)).toBe(0);
    expect(midiToCentsOffset(69.25)).toBeCloseTo(25, 6);
    expect(midiToCentsOffset(68.8)).toBeCloseTo(-20, 6);
  });

  it('returns zero for non-finite MIDI values', () => {
    expect(midiToCentsOffset(Number.NaN)).toBe(0);
    expect(midiToCentsOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });

});

describe('StablePitchTracker', () => {
  it('becomes stable after repeated confident frames of the same note', () => {
    const tracker = new StablePitchTracker();
    const frames = [0, 50, 100, 150].map((t) => tracker.push({ t, midi: 69.05, conf: 0.9 }, 0.6));
    expect(frames[2]?.stable).toBe(false);
    expect(frames[3]?.stable).toBe(true);
    expect(frames[3]?.heldMs).toBe(150);
  });

  it('includes note name in diagnostic state', () => {
    const tracker = new StablePitchTracker();
    const state = tracker.push({ t: 0, midi: 69.0, conf: 0.9 }, 0.6);
    expect(state.noteName).toBe('A4');
  });

  it('returns null activeMidi when confidence is below threshold', () => {
    const tracker = new StablePitchTracker();
    const state = tracker.push({ t: 0, midi: 69.0, conf: 0.3 }, 0.6);
    expect(state.activeMidi).toBeNull();
  });

  it('resets stability when confidence drops and recovers after STABLE_FRAMES_REQUIRED frames', () => {
    const tracker = new StablePitchTracker();
    tracker.push({ t: 0, midi: 69.0, conf: 0.9 }, 0.6);
    tracker.push({ t: 50, midi: 69.1, conf: 0.9 }, 0.6);
    tracker.push({ t: 100, midi: 69.1, conf: 0.9 }, 0.6);
    tracker.push({ t: 150, midi: 69.1, conf: 0.9 }, 0.6);

    const dropped = tracker.push({ t: 200, midi: 69.1, conf: 0.3 }, 0.6);
    expect(dropped.stable).toBe(false);
    expect(dropped.heldMs).toBe(0);

    // One frame back — still not stable (run restarted at 1)
    const recovered1 = tracker.push({ t: 250, midi: 69.1, conf: 0.9 }, 0.6);
    expect(recovered1.stable).toBe(false);
    expect(recovered1.heldMs).toBe(0);

    // Fill remaining frames to reach STABLE_FRAMES_REQUIRED (= 4)
    tracker.push({ t: 300, midi: 69.1, conf: 0.9 }, 0.6);
    tracker.push({ t: 350, midi: 69.1, conf: 0.9 }, 0.6);
    const fullyRecovered = tracker.push({ t: 400, midi: 69.1, conf: 0.9 }, 0.6);
    expect(fullyRecovered.stable).toBe(true);
    expect(fullyRecovered.activeMidi).toBe(69);
  });
});
