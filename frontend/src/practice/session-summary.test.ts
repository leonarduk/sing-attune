import { describe, expect, it } from 'vitest';

import { SessionSummaryTracker } from './session-summary';
import type { NoteModel, TempoMark } from '../score/renderer';

const tempoMarks: TempoMark[] = [{ beat: 0, bpm: 120 }];

const notes: NoteModel[] = [
  { midi: 60, beat_start: 0, duration: 2, measure: 1, part: 'S', lyric: null },
  { midi: 64, beat_start: 2, duration: 2, measure: 1, part: 'S', lyric: null },
  { midi: 67, beat_start: 4, duration: 2, measure: 2, part: 'S', lyric: null },
];

describe('SessionSummaryTracker', () => {
  it('computes note range, deviation, difficult bars, and sustained note', () => {
    const tracker = new SessionSummaryTracker();
    tracker.setContext(tempoMarks, notes);
    tracker.startSession();

    tracker.recordFrame({ t: 0, midi: 60, conf: 0.9 });
    tracker.recordFrame({ t: 200, midi: 60.1, conf: 0.9 });
    tracker.recordFrame({ t: 400, midi: 60.2, conf: 0.9 });
    tracker.recordFrame({ t: 1200, midi: 65, conf: 0.9 });
    tracker.recordFrame({ t: 1800, midi: 67, conf: 0.9 });

    const summary = tracker.finishSession();
    expect(summary).not.toBeNull();
    expect(summary?.lowestNote).toBe('C4');
    expect(summary?.highestNote).toBe('G4');
    expect(summary?.averagePitchDeviationCents).toBeGreaterThan(0);
    expect(summary?.mostDifficultBars[0]?.measure).toBe(1);
    expect(summary?.longestSustainedNote?.noteName).toBe('C4');
    expect(summary?.longestSustainedNote?.durationMs).toBe(400);
  });

  it('ignores low-confidence frames', () => {
    const tracker = new SessionSummaryTracker();
    tracker.setContext(tempoMarks, notes);
    tracker.startSession();

    tracker.recordFrame({ t: 100, midi: 72, conf: 0.5 });

    const summary = tracker.finishSession();
    expect(summary?.lowestNote).toBeNull();
    expect(summary?.highestNote).toBeNull();
    expect(summary?.averagePitchDeviationCents).toBeNull();
    expect(summary?.mostDifficultBars).toEqual([]);
    expect(summary?.longestSustainedNote).toBeNull();
  });
});
