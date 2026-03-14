/**
 * Reactive score session store.
 *
 * After a score loads successfully, `setSession()` is called once with all
 * the objects features need. Features subscribe via `onScoreLoaded()` and
 * can read the current session synchronously via `getSession()`.
 *
 * This replaces the tangle of shared module-level variables that previously
 * lived in monolithic main.ts and had to be threaded through every function
 * by closure.
 *
 * Design notes:
 * - Deliberately NOT a full event-emitter/RxJS observable — that would be
 *   overkill. A single callback list is sufficient.
 * - Sessions are immutable snapshots; mutation happens inside the objects
 *   themselves (engine, cursor, etc.), not in the store.
 * - `clearSession()` is called before each new score load so features can
 *   clean up prior state.
 */
import { type ScoreModel } from '../score/renderer';
import { ScoreCursor } from '../score/cursor';
import { PlaybackEngine } from '../playback/engine';
import { ScoreRenderer } from '../score/renderer';

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
 * Register a callback to be called whenever a new score session is ready.
 * If a session already exists at registration time, the callback is invoked
 * immediately (useful for features that register after the score loads).
 */
export function onScoreLoaded(cb: SessionCallback): void {
  loadedCallbacks.push(cb);
  if (current) cb(current);
}

/** Register a callback to be called before each session tear-down. */
export function onScoreCleared(cb: ClearCallback): void {
  clearCallbacks.push(cb);
}

/**
 * Update the selectedPart on the current session and re-notify listeners.
 * Called by the part-selector feature; pitch-overlay and playback observe it.
 */
export function updateSelectedPart(part: string): void {
  if (!current) return;
  current = { ...current, selectedPart: part };
  for (const cb of loadedCallbacks) cb(current);
}
