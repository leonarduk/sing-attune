import { describe, expect, it } from 'vitest';
import { parsePitchSocketMessage } from './socket';
import { PitchTimelineSync } from './timeline-sync';

describe('pitch frame integration path', () => {
  it('routes websocket frame through timeline sync to graph rendering', () => {
    const timeline = new PitchTimelineSync();
    timeline.reanchor(1000, 10);

    const rendered: Array<{ t: number; midi: number }> = [];
    const payload = { t: 1500, midi: 62, conf: 0.9 };
    const message = parsePitchSocketMessage(payload);
    expect(message.kind).toBe('frame');
    if (message.kind !== 'frame') return;

    const isStale = timeline.isFrameStale(message.frame.t, 10.6, 1000);
    expect(isStale).toBe(false);
    if (!isStale) {
      rendered.push({ t: message.frame.t, midi: message.frame.midi });
    }

    expect(rendered).toEqual([{ t: 1500, midi: 62 }]);
  });

  it('drops stale frames after timeline sync conversion', () => {
    const timeline = new PitchTimelineSync();
    timeline.reanchor(0, 5);

    const message = parsePitchSocketMessage({ t: 200, midi: 60, conf: 0.95 });
    expect(message.kind).toBe('frame');
    if (message.kind !== 'frame') return;

    // nowAudio=8.0 corresponds to frame t=3000ms at this anchor.
    expect(timeline.isFrameStale(message.frame.t, 8.0, 1200)).toBe(true);
  });
});
