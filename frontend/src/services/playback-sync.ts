export type PlaybackSyncEventType = 'start' | 'resume' | 'pause' | 'stop' | 'seek';

export interface PlaybackSyncEvent {
  type: PlaybackSyncEventType;
  tMs: number;
  audioTimeSec: number;
  syncOffsetMs: number | null;
}

type PlaybackSyncListener = (event: PlaybackSyncEvent) => void;

const listeners = new Set<PlaybackSyncListener>();

export function onPlaybackSyncEvent(listener: PlaybackSyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPlaybackSyncEvent(event: PlaybackSyncEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
