import { describe, expect, it } from 'vitest';
import { StableNoteDetector } from './stable-note';

describe('StableNoteDetector', () => {
  it('delays stable output until hold duration is met', () => {
    const detector = new StableNoteDetector({
      minConfidence: 0.6,
      clusteringToleranceCents: 40,
      holdDurationMs: 120,
      smoothingWindowMs: 300,
    });

    expect(detector.pushFrame({ t: 0, midi: 60, conf: 0.9 }).stableMidi).toBeNull();
    expect(detector.pushFrame({ t: 70, midi: 60.05, conf: 0.9 }).stableMidi).toBeNull();
    expect(detector.pushFrame({ t: 130, midi: 59.95, conf: 0.9 }).stableMidi).not.toBeNull();
  });

  it('ignores low-confidence frames', () => {
    const detector = new StableNoteDetector({
      minConfidence: 0.8,
      clusteringToleranceCents: 40,
      holdDurationMs: 80,
      smoothingWindowMs: 250,
    });

    detector.pushFrame({ t: 0, midi: 60, conf: 0.7 });
    detector.pushFrame({ t: 90, midi: 60.1, conf: 0.7 });
    const state = detector.pushFrame({ t: 180, midi: 60.2, conf: 0.7 });
    expect(state.stableMidi).toBeNull();
  });

  it('switches stable note after sustained change', () => {
    const detector = new StableNoteDetector({
      minConfidence: 0.5,
      clusteringToleranceCents: 35,
      holdDurationMs: 100,
      smoothingWindowMs: 260,
    });

    detector.pushFrame({ t: 0, midi: 60, conf: 0.9 });
    detector.pushFrame({ t: 120, midi: 60.02, conf: 0.9 });
    expect(detector.pushFrame({ t: 130, midi: 60.01, conf: 0.9 }).stableMidi).toBeCloseTo(60.01, 1);

    const earlyChange = detector.pushFrame({ t: 170, midi: 62.0, conf: 0.9 });
    expect(earlyChange.stableMidi).toBeCloseTo(60.01, 1);

    detector.pushFrame({ t: 300, midi: 62.02, conf: 0.9 });
    detector.pushFrame({ t: 340, midi: 62.04, conf: 0.9 });
    const switched = detector.pushFrame({ t: 420, midi: 62.01, conf: 0.9 });
    expect(switched.stableMidi).toBeCloseTo(62.0, 1);
  });
});
