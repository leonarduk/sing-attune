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

  it('excludes low-confidence frames from summary aggregation', () => {
    // 120 BPM, 1 note from beat 0-2, phrase ends at beat 2 (1000ms)
    const tracker = new PhraseSummaryTracker([
      { midi: 60, beat_start: 0, duration: 2, measure: 1, part: 'S', lyric: null },
    ], tempo);

    // All frames are badly out of pitch (200c sharp) but below confidence threshold.
    // The summary should reflect zero qualifying samples, so withinTolerancePct = 0
    // and sampleCount = 0 on the note (not inflated by the low-conf frames).
    const frames = [
      { t: 200, midi: 62.0, conf: 0.3 }, // below MIN_CONFIDENCE_FOR_SUMMARY (0.55)
      { t: 400, midi: 62.0, conf: 0.4 },
      { t: 600, midi: 62.0, conf: 0.3 },
      { t: 800, midi: 62.0, conf: 0.4 },
      // cross boundary
      { t: 1100, midi: 60.0, conf: 0.9 },
    ];

    let summaries = [] as ReturnType<PhraseSummaryTracker['pushFrame']>;
    for (const frame of frames) summaries = tracker.pushFrame(frame);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].withinTolerancePct).toBe(0);
    expect(summaries[0].noteSummaries[0].sampleCount).toBe(0);
  });

  it('emits no summary for a phrase with no captured frames (intentional: skip suppression)', () => {
    // Two phrases: phrase 1 (beats 0-2), phrase 2 (beats 3-4).
    // We jump straight to after phrase 2 without any frames inside phrase 1.
    // Expected: no summary emitted — we have no data to show, and an empty card
    // would be misleading. If/when a UI indicator for skipped phrases is wanted,
    // drainCompleted should emit a summary with sampleCount=0 instead of skipping.
    const tracker = new PhraseSummaryTracker(notes, tempo);

    // Single frame at t=2100ms => beat 4.2, past both phrases
    const summaries = tracker.pushFrame({ t: 2100, midi: 60.0, conf: 0.9 });

    // Neither phrase had samples, so neither emits a summary.
    expect(summaries).toHaveLength(0);
  });
});
