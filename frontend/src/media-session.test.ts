import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMediaSession,
  updateMediaSessionMetadata,
  updateMediaSessionState,
  type MediaSessionHandlers,
} from './media-session';

type ActionName = 'play' | 'pause' | 'stop' | 'seekto';

describe('media-session', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('gracefully no-ops when media session is unsupported', () => {
    vi.stubGlobal('navigator', {});

    expect(() => installMediaSession({ play() {}, pause() {}, stop() {} })).not.toThrow();
    expect(() => updateMediaSessionMetadata('Score', 'Tenor')).not.toThrow();
    expect(() => updateMediaSessionState('playing')).not.toThrow();
  });

  it('installs handlers and updates metadata/state when supported', () => {
    const actionHandlers = new Map<ActionName, (...args: unknown[]) => void>();
    const mediaSession = {
      metadata: null,
      playbackState: 'none' as MediaSessionPlaybackState,
      setActionHandler: vi.fn((action: ActionName, handler: (...args: unknown[]) => void) => {
        actionHandlers.set(action, handler);
      }),
    };
    const mediaMetadataCtor = vi.fn((meta) => meta);

    vi.stubGlobal('navigator', { mediaSession });
    vi.stubGlobal('MediaMetadata', mediaMetadataCtor);

    const handlers: MediaSessionHandlers = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seekTo: vi.fn(),
    };

    installMediaSession(handlers);
    updateMediaSessionMetadata('Ave Maria', 'Soprano 1');
    updateMediaSessionState('playing');

    actionHandlers.get('play')?.();
    actionHandlers.get('pause')?.();
    actionHandlers.get('stop')?.();
    actionHandlers.get('seekto')?.({ seekTime: 42 });

    expect(handlers.play).toHaveBeenCalledTimes(1);
    expect(handlers.pause).toHaveBeenCalledTimes(1);
    expect(handlers.stop).toHaveBeenCalledTimes(1);
    expect(handlers.seekTo).toHaveBeenCalledWith(42);
    expect(mediaMetadataCtor).toHaveBeenCalledWith({
      title: 'Ave Maria',
      artist: 'Soprano 1',
      album: 'sing-attune',
    });
    expect(mediaSession.playbackState).toBe('playing');
  });
});
