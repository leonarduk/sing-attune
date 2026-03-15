import { describe, expect, it, beforeEach } from 'vitest';

import {
  buildSessionCsv,
  isSessionRecordingEnabled,
  recordSessionFrame,
  sessionStats,
  setSessionRecordingEnabled,
  startSessionRecording,
  stopSessionRecording,
} from './session-recording';

describe('session recording service', () => {
  beforeEach(() => {
    setSessionRecordingEnabled(false);
  });

  it('records aligned frames when enabled', () => {
    setSessionRecordingEnabled(true);
    expect(isSessionRecordingEnabled()).toBe(true);

    startSessionRecording({
      title: 'Homeward Bound',
      part: 'Tenor',
      tempoMarks: [{ beat: 0, bpm: 60 }],
      notes: [{ midi: 60, beat_start: 0, duration: 2, measure: 1, part: 'Tenor', lyric: null }],
    });

    recordSessionFrame({ t: 500, midi: 60.2, conf: 0.9 });
    const payload = stopSessionRecording();

    expect(payload).not.toBeNull();
    expect(payload?.frames).toHaveLength(1);
    expect(payload?.frames[0].expected_midi).toBe(60);
    expect(payload?.frames[0].measure).toBe(1);
  });

  it('builds csv and stats', () => {
    const session = {
      frames: [
        { t: 0, beat: 0, midi: 60, conf: 0.9, expected_midi: 60, measure: 1 },
        { t: 100, beat: 0.5, midi: 60.6, conf: 0.9, expected_midi: 60, measure: 1 },
        { t: 200, beat: 1, midi: 62.2, conf: 0.9, expected_midi: 62, measure: 2 },
      ],
    };

    const csv = buildSessionCsv(session);
    expect(csv.split('\n')[0]).toBe('beat,expected_midi,sung_midi,cents_deviation');

    const stats = sessionStats(session);
    expect(stats.within50Pct).toBeCloseTo(66.666, 1);
    expect(stats.within100Pct).toBe(100);
    expect(stats.worstMeasure).toBe(1);
  });
});
