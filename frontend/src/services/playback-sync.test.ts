import { describe, expect, it, vi } from 'vitest';
import { emitPlaybackSyncEvent, onPlaybackSyncEvent } from './playback-sync';

describe('playback sync event bus', () => {
  it('publishes pause/resume/seek events with sync offset payload', () => {
    const listener = vi.fn();
    const unsubscribe = onPlaybackSyncEvent(listener);

    emitPlaybackSyncEvent({ type: 'pause', tMs: 1200, audioTimeSec: 5.5, syncOffsetMs: null });
    emitPlaybackSyncEvent({ type: 'resume', tMs: 1250, audioTimeSec: 5.8, syncOffsetMs: 32 });
    emitPlaybackSyncEvent({ type: 'seek', tMs: 3000, audioTimeSec: 8.2, syncOffsetMs: 12 });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: 'pause', tMs: 1200, audioTimeSec: 5.5, syncOffsetMs: null,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'resume', tMs: 1250, audioTimeSec: 5.8, syncOffsetMs: 32,
    });
    expect(listener).toHaveBeenNthCalledWith(3, {
      type: 'seek', tMs: 3000, audioTimeSec: 8.2, syncOffsetMs: 12,
    });

    unsubscribe();
  });
});
