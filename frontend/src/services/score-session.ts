/**
 * Reactive score session store.
 *
 * After a score loads successfully, `setSession()` is called once with all
 * the objects features need. Features subscribe via `onScoreLoaded()` and
 * can read the current session synchronously via `getSession()`.
 *
 * Design notes:
 * - Deliberately NOT a full event-emitter/RxJS observable — overkill here.
 *   A single callback list is sufficient.
 * - Sessions are immutable snapshots; mutation happens inside the objects
 *   themselves (engine, cursor, etc.), not in the store.
 * - `clearSession()` is called before each new score load so features can
 *   clean up prior state.
 */
import { type ScoreModel, ScoreRenderer } from '../score/renderer';
import { ScoreCursor } from '../score/cursor';
import { PlaybackEngine } from '../playback/engine';

export interface ScoreSession {
  model: ScoreModel;
  renderer: ScoreRenderer;
  cursor: ScoreCursor;
  engine: PlaybackEngine;
  /** Currently active part name. */
  selectedPart: string;
}

type SessionCallback = (session: ScoreSession) => void;
type ClearCallback = () => void;

const loadedCallbacks: SessionCallback[] = [];
const partChangedCallbacks: SessionCallback[] = [];
const clearCallbacks: ClearCallback[] = [];

let current: ScoreSession | null = null;

/**
 * Called by the score-loader feature once a score has loaded and all
 * objects are ready. Notifies all registered listeners.
 */
export function setSession(session: ScoreSession): void {
  current = session;
  for (const cb of loadedCallbacks) cb(session);
}

/**
 * Called by the score-loader feature before tearing down a previous session.
 * Notifies all registered listeners so they can clean up.
 */
export function clearSession(): void {
  current = null;
  for (const cb of clearCallbacks) cb();
}

/** Returns the current session, or null if no score is loaded. */
export function getSession(): ScoreSession | null {
  return current;
}

/**
 * Register a callback fired whenever a new score session becomes ready.
 * If a session already exists at registration time the callback fires
 * immediately — useful for features that mount after a score has loaded.
 */
export function onScoreLoaded(cb: SessionCallback): () => void {
  loadedCallbacks.push(cb);
  if (current) cb(current);
  return () => {
    const idx = loadedCallbacks.indexOf(cb);
    if (idx !== -1) loadedCallbacks.splice(idx, 1);
  };
}

/**
 * Register a callback fired whenever selectedPart changes on the current
 * session. If a session already exists at registration time the callback
 * fires immediately with the current selectedPart.
 */
export function onPartChanged(cb: SessionCallback): void {
  partChangedCallbacks.push(cb);
  if (current) cb(current);
}

/** Register a callback fired just before each session tear-down. */
export function onScoreCleared(cb: ClearCallback): () => void {
  clearCallbacks.push(cb);
  return () => {
    const idx = clearCallbacks.indexOf(cb);
    if (idx !== -1) clearCallbacks.splice(idx, 1);
  };
}

/**
 * Update selectedPart on the current session snapshot and notify only
 * onPartChanged subscribers.
 */
export function updateSelectedPart(part: string): void {
  if (!current) return;
  if (current.selectedPart === part) return;
  current = { ...current, selectedPart: part };
  for (const cb of partChangedCallbacks) cb(current);
}
