/**
 * playback feature
 *
 * Owns:
 *   - Transport buttons: #btn-play, #btn-pause, #btn-stop, #btn-rewind
 *   - External cursor RAF loop (AudioContext.currentTime → engine.currentBeat
 *     → cursor.seekToBeat) — must never use Date.now() or wall-clock
 *   - Keyboard shortcuts: Space, R, ArrowLeft, ArrowRight
 *   - #headphone-warning banner
 *
 * Clock hierarchy (must never be broken):
 *   AudioContext.currentTime → engine.currentBeat → cursor.seekToBeat()
 */
import { onScoreCleared, getSession } from '../../services/score-session';
import { setStatus } from '../../services/backend';
import { beatToMs, postPlayback, startPlayback, seekPlayback } from '../../transport/controls';
import { elapsedToBeat } from '../../score/timing';
import { type Feature } from '../../feature-types';

// ── Cursor RAF state ────────────────────────────────────────────────────────────

let cursorRafId: number | null = null;
let cursorBeatSample: { beat: number; x: number } | null = null;
let pxPerBeatEstimate = 0;

function cursorXPosition(): number {
  const session = getSession();
  if (!session) return 0;
  const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement;
  const cursorEl = session.cursor.osmd.cursor.cursorElement;
  if (!cursorEl) return 0;
  const scoreRect = scoreContainerEl.getBoundingClientRect();
  const cursorRect = cursorEl.getBoundingClientRect();
  return cursorRect.left - scoreRect.left + scoreContainerEl.scrollLeft;
}

/**
 * Project a pitch-frame timestamp onto a screen x-coordinate.
 * Exported for the pitch-overlay feature so it can align pitch traces with
 * the cursor without duplicating the px-per-beat estimation logic.
 */
export function getFrameXPosition(frameTMs: number): number {
  const session = getSession();
  if (!session) return cursorXPosition();
  const frameBeat = elapsedToBeat(frameTMs, 0, session.model.tempo_marks);
  if (!cursorBeatSample || pxPerBeatEstimate === 0) return cursorXPosition();
  const projected = cursorBeatSample.x + ((frameBeat - cursorBeatSample.beat) * pxPerBeatEstimate);
  return Number.isFinite(projected) ? projected : cursorXPosition();
}

function startCursorRaf(): void {
  stopCursorRaf();
  function tick(): void {
    const session = getSession();
    if (session?.engine.playing && session.cursor) {
      const beat = session.engine.currentBeat;
      session.cursor.seekToBeat(beat);
      const x = cursorXPosition();
      if (cursorBeatSample !== null) {
        const beatDelta = beat - cursorBeatSample.beat;
        if (Math.abs(beatDelta) > 0.001) {
          const next = (x - cursorBeatSample.x) / beatDelta;
          if (Number.isFinite(next)) {
            pxPerBeatEstimate = pxPerBeatEstimate === 0
              ? next
              : (pxPerBeatEstimate * 0.7) + (next * 0.3);
          }
        }
      }
      cursorBeatSample = { beat, x };
      cursorRafId = requestAnimationFrame(tick);
    }
  }
  cursorRafId = requestAnimationFrame(tick);
}

function stopCursorRaf(): void {
  if (cursorRafId !== null) {
    cancelAnimationFrame(cursorRafId);
    cursorRafId = null;
  }
  cursorBeatSample = null;
  pxPerBeatEstimate = 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function seekByBeats(delta: number): Promise<void> {
  const session = getSession();
  if (!session) return;
  const { engine, cursor, model } = session;
  const stepBeats = model.time_signatures[0]?.numerator ?? 4;
  const targetBeat = Math.max(0,
    Math.min(model.total_beats, engine.currentBeat + delta * stepBeats));
  try {
    await seekPlayback(beatToMs(targetBeat, model, engine.tempoMultiplier));
  } catch (err) {
    setStatus(`seek failed: ${String(err)}`, 'error');
    console.error('Seek failed:', err);
    return;
  }
  engine.seekToBeat(targetBeat);
  cursor.seekToBeat(targetBeat);
  if (engine.state !== 'playing') stopCursorRaf();
}

/** Read the mic device id from the settings-device select (owned by pitch-overlay). */
function getSelectedDeviceId(): number | null {
  const el = document.getElementById('settings-device') as HTMLSelectElement | null;
  if (!el || el.value === '') return null;
  const parsed = Number.parseInt(el.value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── mount ──────────────────────────────────────────────────────────────────

function mount(_slot: HTMLElement): void {
  const btnPlay   = document.getElementById('btn-play')   as HTMLButtonElement;
  const btnPause  = document.getElementById('btn-pause')  as HTMLButtonElement;
  const btnStop   = document.getElementById('btn-stop')   as HTMLButtonElement;
  const btnRewind = document.getElementById('btn-rewind') as HTMLButtonElement;
  const headphoneWarning = document.getElementById('headphone-warning') as HTMLDivElement;
  const warningDismiss   = document.getElementById('warning-dismiss')   as HTMLButtonElement;

  onScoreCleared(() => { stopCursorRaf(); });

  // ── Play ───────────────────────────────────────────────────────────────
  btnPlay.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    const { engine, cursor } = session;
    if (engine.state === 'playing') return;

    headphoneWarning.classList.remove('hidden');
    const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;
    try {
      if (fromBeat > 0) {
        await postPlayback('/playback/resume');
      } else {
        await startPlayback(getSelectedDeviceId());
        cursor.stop();
        cursor.osmd.cursor.show();
      }
      engine.play(fromBeat);
      startCursorRaf();
    } catch (err) {
      setStatus(`playback start failed: ${String(err)}`, 'error');
      console.error('Play failed:', err);
    }
  });

  // ── Pause ─────────────────────────────────────────────────────────────
  btnPause.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try {
      await postPlayback('/playback/pause');
      session.engine.pause();
      stopCursorRaf();
    } catch (err) {
      setStatus(`pause failed: ${String(err)}`, 'error');
      console.error('Pause failed:', err);
    }
  });

  // ── Stop ───────────────────────────────────────────────────────────────
  btnStop.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try {
      await postPlayback('/playback/stop');
      session.engine.stop();
      stopCursorRaf();
      session.cursor.stop();
      headphoneWarning.classList.add('hidden');
    } catch (err) {
      setStatus(`stop failed: ${String(err)}`, 'error');
      console.error('Stop failed:', err);
    }
  });

  // ── Rewind ─────────────────────────────────────────────────────────────
  btnRewind.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try { await postPlayback('/playback/stop'); } catch (err) {
      setStatus(`rewind failed: ${String(err)}`, 'error');
      console.error('Rewind failed:', err);
    }
    session.engine.stop();
    stopCursorRaf();
    session.cursor.stop();
    session.cursor.osmd.cursor.show();
    headphoneWarning.classList.add('hidden');
  });

  warningDismiss.addEventListener('click', () => { headphoneWarning.classList.add('hidden'); });

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.code === 'Space') {
      e.preventDefault();
      const session = getSession();
      if (!session) return;
      if (session.engine.state === 'playing') { btnPause.click(); } else { btnPlay.click(); }
      return;
    }
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (!btnRewind.disabled) btnRewind.click();
      return;
    }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); void seekByBeats(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); void seekByBeats(1); }
  });
}

function unmount(): void {
  stopCursorRaf();
}

export const playbackFeature: Feature = {
  id: 'slot-playback',
  mount,
  unmount,
};
