import { describe, expect, it } from 'vitest';

import { SessionRangeTracker } from './session-range';

describe('SessionRangeTracker', () => {
  it('updates low/high only after stability window', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 300 });

    expect(tracker.ingest({ t: 0, midi: 60.05, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.ingest({ t: 250, midi: 60.02, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.summary()).toBeNull();

    expect(tracker.ingest({ t: 320, midi: 60.00, conf: 0.9 }, 0.75)).toBe(true);
    expect(tracker.summary()).toMatchObject({ lowMidi: 60, highMidi: 60, semitoneSpan: 0, octaveSpan: 0 });

    tracker.ingest({ t: 400, midi: 67.01, conf: 0.9 }, 0.75);
    expect(tracker.ingest({ t: 740, midi: 67.00, conf: 0.9 }, 0.75)).toBe(true);
    expect(tracker.summary()).toMatchObject({ lowMidi: 60, highMidi: 67, semitoneSpan: 7 });
  });

  it('ignores unstable frames from low confidence or large cents deviation', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 200, maxCentsDeviation: 25 });

    tracker.ingest({ t: 0, midi: 62, conf: 0.9 }, 0.75);
    tracker.ingest({ t: 250, midi: 62, conf: 0.9 }, 0.75);
    expect(tracker.summary()).toMatchObject({ lowMidi: 62, highMidi: 62 });

    tracker.ingest({ t: 300, midi: 58, conf: 0.5 }, 0.75);
    tracker.ingest({ t: 600, midi: 58, conf: 0.5 }, 0.75);

    tracker.ingest({ t: 700, midi: 70.5, conf: 0.9 }, 0.75);
    tracker.ingest({ t: 1000, midi: 70.5, conf: 0.9 }, 0.75);

    expect(tracker.summary()).toMatchObject({ lowMidi: 62, highMidi: 62 });
  });

  it('can reset between sessions', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 100 });
    tracker.ingest({ t: 0, midi: 65, conf: 0.9 }, 0.75);
    tracker.ingest({ t: 120, midi: 65, conf: 0.9 }, 0.75);
    expect(tracker.hasRange()).toBe(true);

    tracker.reset();
    expect(tracker.hasRange()).toBe(false);
    expect(tracker.summary()).toBeNull();
  });

  it('accepts frames at exact cents-deviation boundary', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 100, maxCentsDeviation: 40 });

    expect(tracker.ingest({ t: 0, midi: 60.4, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.ingest({ t: 110, midi: 60.4, conf: 0.9 }, 0.75)).toBe(true);
    expect(tracker.summary()).toMatchObject({ lowMidi: 60, highMidi: 60 });
  });

  it('rejects frames with invalid timestamp or midi bounds', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 100 });

    expect(tracker.ingest({ t: -1, midi: 60, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.ingest({ t: 0, midi: -0.1, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.ingest({ t: 0, midi: 127.1, conf: 0.9 }, 0.75)).toBe(false);
    expect(tracker.summary()).toBeNull();
  });

  it('requires continuous stability for rapid note changes', () => {
    const tracker = new SessionRangeTracker({ stabilityMs: 200 });

    tracker.ingest({ t: 0, midi: 60.02, conf: 0.9 }, 0.75);
    tracker.ingest({ t: 80, midi: 62.01, conf: 0.9 }, 0.75);
    tracker.ingest({ t: 160, midi: 60.01, conf: 0.9 }, 0.75);
    expect(tracker.summary()).toBeNull();

    expect(tracker.ingest({ t: 380, midi: 60.00, conf: 0.9 }, 0.75)).toBe(true);
    expect(tracker.summary()).toMatchObject({ lowMidi: 60, highMidi: 60 });
  });

});
