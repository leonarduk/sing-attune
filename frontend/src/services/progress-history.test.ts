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


  it('ignores overlapping captures until the active one is finished', () => {
    startPracticeSessionCapture('First Piece', 'Tenor', new Date('2026-01-01T12:00:00.000Z'));
    startPracticeSessionCapture('Second Piece', 'Bass', new Date('2026-01-01T13:00:00.000Z'));
    capturePitchFrame({ t: 0, midi: 62, conf: 0.9 });

    const summary = finishPracticeSessionCapture();
    expect(summary?.pieceName).toBe('First Piece');

    const stored = loadPracticeHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].pieceName).toBe('First Piece');
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
