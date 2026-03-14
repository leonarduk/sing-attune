/**
 * Cursor x-position projection service.
 *
 * Shared by the playback feature (which writes beat samples via the RAF
 * loop) and the pitch-overlay feature (which reads frame x-positions so
 * pitch traces align with the OSMD cursor).
 *
 * Lives in services/ so neither feature needs to import from the other,
 * preserving feature isolation.
 *
 * Write path (playback feature only):
 *   recordBeatSample(beat, x)  — called every cursor RAF tick
 *   resetProjection()          — called when cursor RAF stops
 *
 * Read path (pitch-overlay feature only):
 *   getFrameXPosition(frameTMs) — projects a pitch-frame timestamp onto screen x
 *   getCursorX()               — raw cursor x (fallback)
 */
import { elapsedToBeat } from '../score/timing';
import { getSession } from './score-session';

// ── Internal state ───────────────────────────────────────────────────────────────

let beatSample: { beat: number; x: number } | null = null;
let pxPerBeat = 0;

// ── Write API (playback feature) ─────────────────────────────────────────────

/**
 * Record a new (beat, x) sample from the cursor RAF loop.
 * Uses light smoothing (0.7/0.3) to reduce jitter from OSMD's stepwise cursor.
 */
export function recordBeatSample(beat: number, x: number): void {
  if (beatSample !== null) {
    const beatDelta = beat - beatSample.beat;
    if (Math.abs(beatDelta) > 0.001) {
      const next = (x - beatSample.x) / beatDelta;
      if (Number.isFinite(next)) {
        pxPerBeat = pxPerBeat === 0 ? next : (pxPerBeat * 0.7) + (next * 0.3);
      }
    }
  }
  beatSample = { beat, x };
}

/** Reset projection state when the cursor RAF stops (stop/pause/rewind). */
export function resetProjection(): void {
  beatSample = null;
  pxPerBeat = 0;
}

// ── Read API (pitch-overlay feature) ────────────────────────────────────────

/** Raw OSMD cursor x-position within #score-container. */
export function getCursorX(): number {
  const session = getSession();
  if (!session) return 0;
  const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement | null;
  if (!scoreContainerEl) return 0;
  const cursorEl = session.cursor.osmd.cursor.cursorElement;
  if (!cursorEl) return 0;
  const scoreRect = scoreContainerEl.getBoundingClientRect();
  const cursorRect = cursorEl.getBoundingClientRect();
  return cursorRect.left - scoreRect.left + scoreContainerEl.scrollLeft;
}

/**
 * Project a pitch-frame timestamp (ms) onto a screen x-coordinate so that
 * pitch traces rendered on the score overlay align with the OSMD cursor.
 */
export function getFrameXPosition(frameTMs: number): number {
  const session = getSession();
  if (!session || !beatSample || pxPerBeat === 0) return getCursorX();
  const frameBeat = elapsedToBeat(frameTMs, 0, session.model.tempo_marks);
  const projected = beatSample.x + ((frameBeat - beatSample.beat) * pxPerBeat);
  return Number.isFinite(projected) ? projected : getCursorX();
}
