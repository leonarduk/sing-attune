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

  it('applySettings mid-stream prunes window and preserves stable state', () => {
    // Build up a stable note with a 500ms window.
    const detector = new StableNoteDetector({
      minConfidence: 0.5,
      clusteringToleranceCents: 40,
      holdDurationMs: 80,
      smoothingWindowMs: 500,
    });

    // Populate window at t=0..200; hold satisfied -> stable = 60
    detector.pushFrame({ t: 0,   midi: 60, conf: 0.9 });
    detector.pushFrame({ t: 100, midi: 60, conf: 0.9 });
    const stableState = detector.pushFrame({ t: 200, midi: 60, conf: 0.9 });
    expect(stableState.stableMidi).not.toBeNull();

    // Shrink window to 100ms: frames at t=0 and t=100 fall outside cutoff
    // (cutoff = 200 - 100 = 100), only t=200 remains.
    // Stable value should survive because candidateStartMs is not reset by applySettings.
    detector.applySettings({
      minConfidence: 0.5,
      clusteringToleranceCents: 40,
      holdDurationMs: 80,
      smoothingWindowMs: 100,
    });

    // Next frame is still within-tolerance; stable state should persist.
    const after = detector.pushFrame({ t: 250, midi: 60.02, conf: 0.9 });
    expect(after.stableMidi).not.toBeNull();

    // Frames from an entirely different pitch cluster now arrive; stable should
    // eventually flip once hold is satisfied for the new candidate.
    detector.pushFrame({ t: 300, midi: 64, conf: 0.9 });
    const beforeSwitch = detector.pushFrame({ t: 370, midi: 64, conf: 0.9 });
    // Hold not yet met from first 64-cluster frame (370-300=70ms < 80ms holdDurationMs).
    expect(beforeSwitch.stableMidi).toBeCloseTo(60, 1);

    const afterSwitch = detector.pushFrame({ t: 410, midi: 64, conf: 0.9 });
    // 410-300=110ms > 80ms hold -> should have switched
    expect(afterSwitch.stableMidi).toBeCloseTo(64, 1);
  });

  it('clustering dominant cluster is consistent regardless of frame arrival order', () => {
    // Two distinct pitch clusters: A around midi 60, B around midi 63.
    // Cluster A has more frames so it should always win, regardless of order.
    const settings = {
      minConfidence: 0.5,
      clusteringToleranceCents: 100, // 1 semitone: keeps clusters separate
      holdDurationMs: 50,
      smoothingWindowMs: 1000,
    };

    // Forward order: A frames first, then B
    const detectorFwd = new StableNoteDetector(settings);
    detectorFwd.pushFrame({ t: 0,   midi: 60.0, conf: 0.9 }); // A
    detectorFwd.pushFrame({ t: 20,  midi: 60.1, conf: 0.9 }); // A
    detectorFwd.pushFrame({ t: 40,  midi: 60.0, conf: 0.9 }); // A
    detectorFwd.pushFrame({ t: 60,  midi: 63.0, conf: 0.9 }); // B
    const fwdResult = detectorFwd.pushFrame({ t: 100, midi: 60.05, conf: 0.9 }); // A - hold met
    expect(fwdResult.stableMidi).toBeCloseTo(60.0, 0);

    // Interleaved order: A and B frames mixed
    const detectorMix = new StableNoteDetector(settings);
    detectorMix.pushFrame({ t: 0,   midi: 63.0, conf: 0.9 }); // B
    detectorMix.pushFrame({ t: 20,  midi: 60.0, conf: 0.9 }); // A
    detectorMix.pushFrame({ t: 40,  midi: 60.1, conf: 0.9 }); // A
    detectorMix.pushFrame({ t: 60,  midi: 60.0, conf: 0.9 }); // A
    const mixResult = detectorMix.pushFrame({ t: 100, midi: 60.05, conf: 0.9 }); // A - hold met
    expect(mixResult.stableMidi).toBeCloseTo(60.0, 0);
  });
});
