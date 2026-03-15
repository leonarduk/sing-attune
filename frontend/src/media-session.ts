export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  stop(): void;
  seekTo?(seconds: number): void;
}

function hasMediaSession(): boolean {
  return 'mediaSession' in navigator;
}

export function installMediaSession(handlers: MediaSessionHandlers): void {
  if (!hasMediaSession()) return;

  navigator.mediaSession.setActionHandler('play', () => handlers.play());
  navigator.mediaSession.setActionHandler('pause', () => handlers.pause());
  navigator.mediaSession.setActionHandler('stop', () => handlers.stop());

  if (handlers.seekTo) {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) handlers.seekTo?.(details.seekTime);
    });
  }
}

export function updateMediaSessionMetadata(scoreTitle: string, partName: string): void {
  if (!hasMediaSession()) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: scoreTitle || 'sing-attune session',
    artist: partName || '',
    album: 'sing-attune',
  });
}

export function updateMediaSessionState(state: MediaSessionPlaybackState): void {
  if (!hasMediaSession()) return;
  navigator.mediaSession.playbackState = state;
}
