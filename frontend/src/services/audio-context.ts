/**
 * Lazy singleton AudioContext + SoundfontLoader.
 *
 * Features must not construct AudioContext directly; they call
 * getAudioContext() / getSoundfont() so the context is shared across the app
 * and created only once (on first score load, after a user gesture).
 *
 * Clock hierarchy contract:
 *   AudioContext.currentTime is the master clock — nothing else may be used
 *   for audio/visual synchronisation.
 */
import { SoundfontLoader } from '../playback/soundfont';

let ctx: AudioContext | null = null;
let soundfont: SoundfontLoader | null = null;
let loadPromise: Promise<void> | null = null;

export type PlaybackTimbreMode = 'loading' | 'soundfont' | 'synth-fallback';

let playbackTimbreMode: PlaybackTimbreMode = 'loading';
const playbackTimbreModeListeners = new Set<(mode: PlaybackTimbreMode) => void>();

function setPlaybackTimbreMode(mode: PlaybackTimbreMode): void {
  playbackTimbreMode = mode;
  for (const listener of playbackTimbreModeListeners) {
    listener(mode);
  }
}

/**
 * Return (creating if necessary) the shared AudioContext.
 * Also kicks off soundfont loading in the background on first call.
 */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

/**
 * Return (creating if necessary) the shared SoundfontLoader.
 * Starts the download on first call; subsequent calls return the same instance.
 */
export function getSoundfont(): SoundfontLoader {
  if (!soundfont) {
    soundfont = new SoundfontLoader();
  }
  return soundfont;
}

/**
 * Kick off soundfont loading (idempotent).
 * Returns the promise so callers can await readiness before scheduling notes.
 */
export function ensureSoundfontLoaded(
  onError?: (err: unknown) => void,
): Promise<void> {
  if (!loadPromise) {
    setPlaybackTimbreMode('loading');
    const ac = getAudioContext();
    const sf = getSoundfont();
    loadPromise = sf.load(ac)
      .then(() => {
        setPlaybackTimbreMode('soundfont');
      })
      .catch((err: unknown) => {
        setPlaybackTimbreMode('synth-fallback');
        console.error('[Soundfont] load failed:', err);
        onError?.(err);
      });
  }
  return loadPromise;
}

/** Expose the raw load promise for features that need to await it. */
export function getSoundfontLoadPromise(): Promise<void> | null {
  return loadPromise;
}

export function getPlaybackTimbreMode(): PlaybackTimbreMode {
  return playbackTimbreMode;
}

export function onPlaybackTimbreModeChange(
  listener: (mode: PlaybackTimbreMode) => void,
): () => void {
  playbackTimbreModeListeners.add(listener);
  return () => {
    playbackTimbreModeListeners.delete(listener);
  };
}
