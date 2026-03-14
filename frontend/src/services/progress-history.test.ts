import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capturePitchFrame,
  clearPracticeHistory,
  exportPracticeHistory,
  finishPracticeSessionCapture,
  loadPracticeHistory,
  startPracticeSessionCapture,
} from './progress-history';

describe('progress history', () => {
  beforeEach(() => {
    clearPracticeHistory();
    vi.restoreAllMocks();
  });

  it('stores a completed session summary with range and confidence stats', () => {
    startPracticeSessionCapture('Ave Maria', 'Soprano', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 60, conf: 0.7 });
    capturePitchFrame({ t: 400, midi: 67, conf: 0.9 });
    capturePitchFrame({ t: 900, midi: 64, conf: 0.8 });

    const summary = finishPracticeSessionCapture();
    expect(summary).not.toBeNull();
    expect(summary?.pieceName).toBe('Ave Maria');
    expect(summary?.part).toBe('Soprano');
    expect(summary?.minMidi).toBe(60);
    expect(summary?.maxMidi).toBe(67);
    // All three frames are above MIN_VOICED_CONFIDENCE (0.5), so all are included.
    expect(summary?.averageConfidence).toBeCloseTo(0.8, 8);
    // 100(default) + 400 + 500 = 1000
    expect(summary?.singingDurationMs).toBe(1000);

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].pieceName).toBe('Ave Maria');
  });

  it('ignores long frame gaps when calculating singing duration', () => {
    startPracticeSessionCapture('Test Piece', 'Alto', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,    midi: 55, conf: 0.8 }); // +100 (default)
    capturePitchFrame({ t: 5000, midi: 57, conf: 0.8 }); // gap > 2000ms, skipped
    capturePitchFrame({ t: 5200, midi: 58, conf: 0.8 }); // +200

    const summary = finishPracticeSessionCapture();
    expect(summary?.singingDurationMs).toBe(300);
  });

  it('skips out-of-order frames for duration (monotonic clock)', () => {
    startPracticeSessionCapture('Test Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 60, conf: 0.8 }); // +100 (default), HWM=0
    capturePitchFrame({ t: 200, midi: 62, conf: 0.8 }); // +200, HWM=200
    capturePitchFrame({ t: 100, midi: 61, conf: 0.8 }); // out-of-order: t<HWM, skip for duration
    capturePitchFrame({ t: 400, midi: 63, conf: 0.8 }); // +200 (400-200), HWM=400

    const summary = finishPracticeSessionCapture();
    // 100 + 200 + 0 (skipped) + 200 = 500ms
    expect(summary?.singingDurationMs).toBe(500);
    // Out-of-order frame midi=61 should still count for range
    expect(summary?.minMidi).toBe(60);
    expect(summary?.maxMidi).toBe(63);
  });

  it('excludes low-confidence frames from range and average confidence stats', () => {
    startPracticeSessionCapture('Test Piece', 'Bass', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 40, conf: 0.1 }); // below threshold — should not affect range
    capturePitchFrame({ t: 100, midi: 60, conf: 0.8 }); // voiced
    capturePitchFrame({ t: 200, midi: 64, conf: 0.9 }); // voiced
    capturePitchFrame({ t: 300, midi: 30, conf: 0.3 }); // below threshold — should not affect range

    const summary = finishPracticeSessionCapture();
    // Range must only reflect the two voiced frames
    expect(summary?.minMidi).toBe(60);
    expect(summary?.maxMidi).toBe(64);
    // Average must only include voiced frames: (0.8 + 0.9) / 2 = 0.85
    expect(summary?.averageConfidence).toBeCloseTo(0.85, 8);
    // Duration accumulates for all in-order frames regardless of confidence
    // 100(default) + 100 + 100 + 100 = 400
    expect(summary?.singingDurationMs).toBe(400);
  });

  it('ignores overlapping captures until the active one is finished', () => {
    startPracticeSessionCapture('First Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    // Second start while first is active — must be a no-op; first keeps accumulating
    startPracticeSessionCapture('Second Piece', 'Bass', new Date('2026-01-01T13:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 62, conf: 0.9 });
    capturePitchFrame({ t: 600, midi: 62, conf: 0.9 }); // ensure duration > MIN_SESSION_DURATION_MS

    const summary = finishPracticeSessionCapture();
    expect(summary?.pieceName).toBe('First Piece');

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].pieceName).toBe('First Piece');
  });

  it('discards session with no frames (returns null, nothing saved)', () => {
    startPracticeSessionCapture('Empty Piece', 'Alto', new Date('2026-01-01T12:00:00.000Z'));
    const summary = finishPracticeSessionCapture();
    expect(summary).toBeNull();
    expect(loadPracticeHistory()).toHaveLength(0);
  });

  it('discards session below minimum duration threshold', () => {
    startPracticeSessionCapture('Flash Piece', 'Soprano', new Date('2026-01-01T12:00:00.000Z'));
    // Only one frame — contributes DEFAULT_FRAME_DURATION_MS (100ms) < MIN_SESSION_DURATION_MS (500ms)
    capturePitchFrame({ t: 0, midi: 60, conf: 0.8 });
    const summary = finishPracticeSessionCapture();
    expect(summary).toBeNull();
    expect(loadPracticeHistory()).toHaveLength(0);
  });

  it('returns empty array when localStorage contains invalid JSON', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{not valid json}}}');
    const result = loadPracticeHistory();
    expect(result).toEqual([]);
    getItemSpy.mockRestore();
  });

  it('enforces MAX_SAVED_SESSIONS cap of 250', () => {
    for (let i = 0; i < 250; i++) {
      startPracticeSessionCapture(`Piece ${i}`, 'Soprano', new Date('2026-01-01T12:00:00.000Z'));
      capturePitchFrame({ t: 0,    midi: 60, conf: 0.8 });
      capturePitchFrame({ t: 1000, midi: 60, conf: 0.8 }); // ensure > MIN_SESSION_DURATION_MS
      finishPracticeSessionCapture();
    }
    expect(loadPracticeHistory()).toHaveLength(250);

    startPracticeSessionCapture('Overflow Piece', 'Alto', new Date('2026-01-02T12:00:00.000Z'));
    capturePitchFrame({ t: 0,    midi: 62, conf: 0.8 });
    capturePitchFrame({ t: 1000, midi: 62, conf: 0.8 });
    finishPracticeSessionCapture();

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(250);
    expect(stored[0].pieceName).toBe('Overflow Piece');
  });

  it('exports stored history as JSON', () => {
    startPracticeSessionCapture('Test Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,    midi: 60, conf: 0.7 });
    capturePitchFrame({ t: 1000, midi: 60, conf: 0.7 }); // ensure > MIN_SESSION_DURATION_MS
    finishPracticeSessionCapture();

    const exported = exportPracticeHistory();
    const parsed = JSON.parse(exported) as Array<{ pieceName: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pieceName).toBe('Test Piece');
  });
});
