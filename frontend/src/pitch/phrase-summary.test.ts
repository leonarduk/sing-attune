import { describe, expect, it } from 'vitest';
import type { NoteModel, TempoMark } from '../score/renderer';
import { PhraseSummaryTracker, segmentPhrases } from './phrase-summary';

const tempo: TempoMark[] = [{ beat: 0, bpm: 120 }];

const notes: NoteModel[] = [
  { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'S', lyric: null },
  { midi: 62, beat_start: 1, duration: 1, measure: 1, part: 'S', lyric: null },
  { midi: 64, beat_start: 3, duration: 1, measure: 2, part: 'S', lyric: null },
];

describe('segmentPhrases', () => {
  it('splits phrases using beat gaps', () => {
    const phrases = segmentPhrases(notes);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].startBeat).toBe(0);
    expect(phrases[0].endBeat).toBe(2);
    expect(phrases[1].startBeat).toBe(3);
    expect(phrases[1].endBeat).toBe(4);
  });
});

describe('PhraseSummaryTracker', () => {
  it('emits a completed phrase summary when playback crosses phrase boundary', () => {
    const tracker = new PhraseSummaryTracker(notes, tempo);

    // 120 BPM => 500ms per beat
    const frames = [
      { t: 100, midi: 60.0, conf: 0.9 },
      { t: 300, midi: 60.2, conf: 0.9 },
      { t: 550, midi: 62.0, conf: 0.9 },
      { t: 900, midi: 62.1, conf: 0.9 },
      // crosses beat 2 boundary, should flush phrase 1
      { t: 1100, midi: 64.0, conf: 0.9 },
    ];

    let summaries = [] as ReturnType<PhraseSummaryTracker['pushFrame']>;
    for (const frame of frames) summaries = tracker.pushFrame(frame);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].phraseId).toBe(1);
    expect(summaries[0].withinTolerancePct).toBeGreaterThan(50);
    expect(summaries[0].noteSummaries).toHaveLength(2);
  });

  it('marks directional bias when enough consistent signed samples exist', () => {
    const tracker = new PhraseSummaryTracker([
      { midi: 60, beat_start: 0, duration: 2, measure: 1, part: 'S', lyric: null },
    ], tempo);

    const frames = [
      { t: 100, midi: 60.2, conf: 0.9 },
      { t: 200, midi: 60.22, conf: 0.9 },
      { t: 300, midi: 60.24, conf: 0.9 },
      { t: 400, midi: 60.23, conf: 0.9 },
      { t: 500, midi: 60.21, conf: 0.9 },
      { t: 600, midi: 60.25, conf: 0.9 },
      { t: 700, midi: 60.2, conf: 0.9 },
      { t: 800, midi: 60.22, conf: 0.9 },
      // beat 2 boundary at 1000ms
      { t: 1100, midi: 61.0, conf: 0.9 },
    ];

    let summaries = [] as ReturnType<PhraseSummaryTracker['pushFrame']>;
    for (const frame of frames) summaries = tracker.pushFrame(frame);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].noteSummaries[0].direction).toBe('sharp');
  });
});
