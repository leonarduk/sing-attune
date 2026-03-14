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
    capturePitchFrame({ t: 0, midi: 60, conf: 0.7 });
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
    expect(summary?.singingDurationMs).toBe(1000);

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].pieceName).toBe('Ave Maria');
  });

  it('ignores long frame gaps when calculating singing duration', () => {
    startPracticeSessionCapture('Test Piece', 'Alto', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0, midi: 55, conf: 0.8 });
    capturePitchFrame({ t: 5000, midi: 57, conf: 0.8 });
    capturePitchFrame({ t: 5200, midi: 58, conf: 0.8 });

    const summary = finishPracticeSessionCapture();
    expect(summary?.singingDurationMs).toBe(300);
  });

  it('handles out-of-order frames by using absolute delta for duration', () => {
    startPracticeSessionCapture('Test Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 60, conf: 0.8 });  // +100 (first frame default)
    capturePitchFrame({ t: 200, midi: 62, conf: 0.8 });  // +200
    capturePitchFrame({ t: 100, midi: 61, conf: 0.8 });  // out-of-order: abs(100-200)=100, within gap limit
    capturePitchFrame({ t: 400, midi: 63, conf: 0.8 });  // abs(400-100)=300

    const summary = finishPracticeSessionCapture();
    // 100 + 200 + 100 + 300 = 700
    expect(summary?.singingDurationMs).toBe(700);
  });

  it('excludes low-confidence frames from range and average confidence stats', () => {
    startPracticeSessionCapture('Test Piece', 'Bass', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0,   midi: 40, conf: 0.1 });  // below threshold — should not affect range
    capturePitchFrame({ t: 100, midi: 60, conf: 0.8 });  // voiced
    capturePitchFrame({ t: 200, midi: 64, conf: 0.9 });  // voiced
    capturePitchFrame({ t: 300, midi: 30, conf: 0.3 });  // below threshold — should not affect range

    const summary = finishPracticeSessionCapture();
    // Range must only reflect the two voiced frames
    expect(summary?.minMidi).toBe(60);
    expect(summary?.maxMidi).toBe(64);
    // Average must only include voiced frames: (0.8 + 0.9) / 2 = 0.85
    expect(summary?.averageConfidence).toBeCloseTo(0.85, 8);
    // Duration accumulates for all frames regardless of confidence
    expect(summary?.singingDurationMs).toBe(400); // 100 + 100 + 100 + 100
  });

  it('ignores overlapping captures until the active one is finished', () => {
    startPracticeSessionCapture('First Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    // Second start while first is active — must be a no-op; first keeps accumulating
    startPracticeSessionCapture('Second Piece', 'Bass', new Date('2026-01-01T13:00:00.000Z'));
    capturePitchFrame({ t: 0, midi: 62, conf: 0.9 });

    const summary = finishPracticeSessionCapture();
    expect(summary?.pieceName).toBe('First Piece');

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].pieceName).toBe('First Piece');
  });

  it('returns empty array when localStorage contains invalid JSON', () => {
    // Simulate corrupt storage by injecting bad JSON via the memory fallback.
    // clearPracticeHistory + direct write exercises parseStoredSessions error path.
    // We test via loadPracticeHistory after manually corrupting the stored value.
    // The simplest approach: spy on getItem to return garbage.
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{not valid json}}}');
    const result = loadPracticeHistory();
    expect(result).toEqual([]);
    getItemSpy.mockRestore();
  });

  it('enforces MAX_SAVED_SESSIONS cap of 250', () => {
    // Store 250 sessions first
    for (let i = 0; i < 250; i++) {
      startPracticeSessionCapture(`Piece ${i}`, 'Soprano', new Date('2026-01-01T12:00:00.000Z'));
      capturePitchFrame({ t: 0, midi: 60, conf: 0.8 });
      finishPracticeSessionCapture();
    }
    expect(loadPracticeHistory()).toHaveLength(250);

    // Adding one more must evict the oldest
    startPracticeSessionCapture('Overflow Piece', 'Alto', new Date('2026-01-02T12:00:00.000Z'));
    capturePitchFrame({ t: 0, midi: 62, conf: 0.8 });
    finishPracticeSessionCapture();

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(250);
    // Newest is prepended, so it should be first
    expect(stored[0].pieceName).toBe('Overflow Piece');
  });

  it('exports stored history as JSON', () => {
    startPracticeSessionCapture('Test Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    capturePitchFrame({ t: 0, midi: 60, conf: 0.7 });
    finishPracticeSessionCapture();

    const exported = exportPracticeHistory();
    const parsed = JSON.parse(exported) as Array<{ pieceName: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pieceName).toBe('Test Piece');
  });
});
