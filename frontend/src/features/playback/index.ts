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
 *
 * The cursor x-projection logic (beat → screen x) is kept in
 * services/cursor-projection.ts so pitch-overlay can read it without
 * importing from this feature.
 */
import { onScoreCleared, getSession } from '../../services/score-session';
import { setStatus } from '../../services/backend';
import { recordBeatSample, resetProjection, getCursorX } from '../../services/cursor-projection';
import { beatToMs, postPlayback, startPlayback, seekPlayback } from '../../transport/controls';
import { sessionSummaryTracker, type SessionSummary } from '../../practice/session-summary';
import { type Feature } from '../../feature-types';

// ── Cursor RAF ──────────────────────────────────────────────────────────────────

let cursorRafId: number | null = null;

function startCursorRaf(): void {
  stopCursorRaf();
  function tick(): void {
    const session = getSession();
    if (session?.engine.playing && session.cursor) {
      const beat = session.engine.currentBeat;
      session.cursor.seekToBeat(beat);
      recordBeatSample(beat, getCursorX());
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
  resetProjection();
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

function getSelectedDeviceId(): number | null {
  const el = document.getElementById('settings-device') as HTMLSelectElement | null;
  if (!el || el.value === '') return null;
  const parsed = Number.parseInt(el.value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatSummary(summary: SessionSummary): string {
  const avgDeviation = summary.averagePitchDeviationCents === null
    ? '—'
    : `${summary.averagePitchDeviationCents.toFixed(1)} cents`;
  const difficultBars = summary.mostDifficultBars.length === 0
    ? 'No aligned bars yet.'
    : summary.mostDifficultBars
      .map((bar) => `Bar ${bar.measure}: ${bar.avgDeviationCents.toFixed(1)} cents`)
      .join(' · ');
  const sustained = summary.longestSustainedNote
    ? `${summary.longestSustainedNote.noteName} (${(summary.longestSustainedNote.durationMs / 1000).toFixed(2)}s)`
    : '—';

  return [
    `Lowest note: ${summary.lowestNote ?? '—'}`,
    `Highest note: ${summary.highestNote ?? '—'}`,
    `Average pitch deviation: ${avgDeviation}`,
    `Most difficult bars: ${difficultBars}`,
    `Longest sustained note: ${sustained}`,
  ].join('\n');
}

function showSessionSummary(summary: SessionSummary): void {
  const modal = document.getElementById('session-summary-modal') as HTMLDivElement;
  const content = document.getElementById('session-summary-content') as HTMLPreElement;
  if (!modal || !content) return;
  content.textContent = formatSummary(summary);
  modal.classList.remove('hidden');
}

function hideSessionSummary(): void {
  const modal = document.getElementById('session-summary-modal') as HTMLDivElement;
  modal?.classList.add('hidden');
}

// ── mount ─────────────────────────────────────────────────────────────────

function mount(_slot: HTMLElement): void {
  const btnPlay   = document.getElementById('btn-play')   as HTMLButtonElement;
  const btnPause  = document.getElementById('btn-pause')  as HTMLButtonElement;
  const btnStop   = document.getElementById('btn-stop')   as HTMLButtonElement;
  const btnRewind = document.getElementById('btn-rewind') as HTMLButtonElement;
  const headphoneWarning = document.getElementById('headphone-warning') as HTMLDivElement;
  const warningDismiss   = document.getElementById('warning-dismiss')   as HTMLButtonElement;
  const summaryClose     = document.getElementById('btn-summary-close')  as HTMLButtonElement;
  const summaryRetry     = document.getElementById('btn-summary-retry')  as HTMLButtonElement;
  const summaryReplay    = document.getElementById('btn-summary-replay') as HTMLButtonElement;

  onScoreCleared(() => { stopCursorRaf(); });

  btnPlay.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    const { engine, cursor } = session;
    if (engine.state === 'playing') return;
    headphoneWarning.classList.remove('hidden');
    const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;
    try {
      hideSessionSummary();
      if (fromBeat > 0) {
        await postPlayback('/playback/resume');
      } else {
        sessionSummaryTracker.startSession();
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

  btnStop.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try {
      await postPlayback('/playback/stop');
      session.engine.stop();
      stopCursorRaf();
      session.cursor.stop();
      headphoneWarning.classList.add('hidden');
      const summary = sessionSummaryTracker.finishSession();
      if (summary) showSessionSummary(summary);
    } catch (err) {
      setStatus(`stop failed: ${String(err)}`, 'error');
      console.error('Stop failed:', err);
    }
  });

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
    sessionSummaryTracker.reset();
    hideSessionSummary();
  });

  warningDismiss.addEventListener('click', () => { headphoneWarning.classList.add('hidden'); });
  summaryClose.addEventListener('click', () => { hideSessionSummary(); });
  summaryRetry.addEventListener('click', () => {
    hideSessionSummary();
    btnRewind.click();
    btnPlay.click();
  });
  summaryReplay.addEventListener('click', () => {
    hideSessionSummary();
    btnRewind.click();
    btnPlay.click();
  });

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
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); if (!btnRewind.disabled) btnRewind.click(); return; }
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
