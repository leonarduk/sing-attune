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
import { SoundfontLoader, type PlaybackInstrumentId } from '../playback/soundfont';
import { loadPlaybackVoiceId } from './audio-preflight';

let ctx: AudioContext | null = null;
let soundfont: SoundfontLoader | null = null;
let loadPromise: Promise<void> | null = null;

// Generation guard (#361 review fix): setPlaybackInstrument()/retrySoundfontLoad()
// swap `soundfont` and null `loadPromise` without cancelling the in-flight fetch
// behind a previous ensureSoundfontLoaded() call. Without this counter, a slow
// stale load could settle *after* a newer (possibly failed) voice switch and
// clobber playbackTimbreMode with its own outcome. Each ensureSoundfontLoaded()
// call that actually starts a new load captures the post-increment value; its
// .then()/.catch() side effects only apply if no newer load has started since.
let loadGeneration = 0;

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
    soundfont = new SoundfontLoader(loadPlaybackVoiceId());
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
    const generation = ++loadGeneration;
    setPlaybackTimbreMode('loading');
    const ac = getAudioContext();
    const sf = getSoundfont();
    loadPromise = sf.load(ac)
      .then(() => {
        // Stale load superseded by a later voice switch — drop its result.
        if (generation !== loadGeneration) return;
        setPlaybackTimbreMode('soundfont');
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setPlaybackTimbreMode('synth-fallback');
        console.error('[Soundfont] load failed:', err);
        onError?.(err);
      });
  }
  return loadPromise;
}

/**
 * Force a new soundfont fetch cycle after a previous failure.
 */
export function retrySoundfontLoad(onError?: (err: unknown) => void): Promise<void> {
  soundfont = new SoundfontLoader(loadPlaybackVoiceId());
  loadPromise = null;
  return ensureSoundfontLoaded(onError);
}

/**
 * Switch the playback voice (GM instrument) and reload immediately.
 * Used by the settings panel's "Playback voice" control (#361) so a change
 * takes effect without requiring a page reload.
 */
export function setPlaybackInstrument(
  instrumentId: PlaybackInstrumentId,
  onError?: (err: unknown) => void,
): Promise<void> {
  soundfont = new SoundfontLoader(instrumentId);
  loadPromise = null;
  return ensureSoundfontLoaded(onError);
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
