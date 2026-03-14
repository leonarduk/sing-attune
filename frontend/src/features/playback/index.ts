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
import { onScoreCleared, onScoreLoaded, getSession } from '../../services/score-session';
import { setStatus } from '../../services/backend';
import { recordBeatSample, resetProjection, getCursorX } from '../../services/cursor-projection';
import { finishPracticeSessionCapture, startPracticeSessionCapture } from '../../services/progress-history';
import { emitPlaybackSyncEvent } from '../../services/playback-sync';
import { beatToMs, postPlayback, startPlayback, seekPlayback } from '../../transport/controls';
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
    const audioTimeSec = engine.ctx.currentTime;
    const response = await seekPlayback(beatToMs(targetBeat, model, engine.tempoMultiplier));
    emitPlaybackSyncEvent({
      type: 'seek',
      tMs: response.t_ms,
      audioTimeSec,
      syncOffsetMs: null,
    });
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

// ── mount ─────────────────────────────────────────────────────────────────

function mount(_slot: HTMLElement): void {
  const btnPlay   = document.getElementById('btn-play')   as HTMLButtonElement;
  const btnPause  = document.getElementById('btn-pause')  as HTMLButtonElement;
  const btnStop   = document.getElementById('btn-stop')   as HTMLButtonElement;
  const btnRewind = document.getElementById('btn-rewind') as HTMLButtonElement;
  const headphoneWarning = document.getElementById('headphone-warning') as HTMLDivElement;
  const warningDismiss   = document.getElementById('warning-dismiss')   as HTMLButtonElement;

  onScoreCleared(() => { stopCursorRaf(); });
  onScoreCleared(() => { finishPracticeSessionCapture(); });
  function syncPauseButton(): void {
    const session = getSession();
    if (!session) {
      btnPause.disabled = true;
      btnPause.innerHTML = '&#9646;&#9646; Pause';
      return;
    }
    if (session.engine.state === 'playing') {
      btnPause.disabled = false;
      btnPause.innerHTML = '&#9646;&#9646; Pause';
      return;
    }
    if (session.engine.state === 'paused') {
      btnPause.disabled = false;
      btnPause.innerHTML = '&#9654; Resume';
      return;
    }
    btnPause.disabled = true;
    btnPause.innerHTML = '&#9646;&#9646; Pause';
  }

  onScoreLoaded(() => { syncPauseButton(); });
  onScoreCleared(() => { stopCursorRaf(); syncPauseButton(); });

  btnPlay.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    const { engine, cursor } = session;
    if (engine.state === 'playing') return;
    headphoneWarning.classList.remove('hidden');
    const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;
    try {
      if (fromBeat > 0) {
        const audioTimeSec = engine.ctx.currentTime;
        const response = await postPlayback('/playback/resume');
        emitPlaybackSyncEvent({
          type: 'resume',
          tMs: response.t_ms,
          audioTimeSec,
          syncOffsetMs: null,
        });
      } else {
        startPracticeSessionCapture(session.model.title, session.selectedPart);
        await startPlayback(getSelectedDeviceId());
        const audioTimeSec = engine.ctx.currentTime;
        const response = await startPlayback(getSelectedDeviceId());
        emitPlaybackSyncEvent({
          type: 'start',
          tMs: response.t_ms,
          audioTimeSec,
          syncOffsetMs: null,
        });
        cursor.stop();
        cursor.osmd.cursor.show();
      }
      engine.play(fromBeat);
      startCursorRaf();
      syncPauseButton();
    } catch (err) {
      setStatus(`playback start failed: ${String(err)}`, 'error');
      console.error('Play failed:', err);
    }
  });

  btnPause.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    const { engine } = session;
    try {
      if (engine.state === 'playing') {
        const audioTimeSec = engine.ctx.currentTime;
        const response = await postPlayback('/playback/pause');
        emitPlaybackSyncEvent({
          type: 'pause',
          tMs: response.t_ms,
          audioTimeSec,
          syncOffsetMs: null,
        });
        engine.pause();
        stopCursorRaf();
      } else if (engine.state === 'paused') {
        const audioTimeSec = engine.ctx.currentTime;
        const response = await postPlayback('/playback/resume');
        emitPlaybackSyncEvent({
          type: 'resume',
          tMs: response.t_ms,
          audioTimeSec,
          syncOffsetMs: null,
        });
        engine.play(engine.startBeat);
        startCursorRaf();
      }
      syncPauseButton();
    } catch (err) {
      setStatus(`pause failed: ${String(err)}`, 'error');
      console.error('Pause failed:', err);
    }
  });

  btnStop.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try {
      const audioTimeSec = session.engine.ctx.currentTime;
      const response = await postPlayback('/playback/stop');
      session.engine.stop();
      finishPracticeSessionCapture();
      emitPlaybackSyncEvent({
        type: 'stop',
        tMs: response.t_ms,
        audioTimeSec,
        syncOffsetMs: null,
      });
      stopCursorRaf();
      session.cursor.stop();
      headphoneWarning.classList.add('hidden');
      syncPauseButton();
    } catch (err) {
      setStatus(`stop failed: ${String(err)}`, 'error');
      console.error('Stop failed:', err);
    }
  });

  btnRewind.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    try {
      const audioTimeSec = session.engine.ctx.currentTime;
      const response = await postPlayback('/playback/stop');
      emitPlaybackSyncEvent({
        type: 'stop',
        tMs: response.t_ms,
        audioTimeSec,
        syncOffsetMs: null,
      });
    } catch (err) {
      setStatus(`rewind failed: ${String(err)}`, 'error');
      console.error('Rewind failed:', err);
    }
    session.engine.stop();
    finishPracticeSessionCapture();
    stopCursorRaf();
    session.cursor.stop();
    session.cursor.osmd.cursor.show();
    headphoneWarning.classList.add('hidden');
    syncPauseButton();
  });

  warningDismiss.addEventListener('click', () => { headphoneWarning.classList.add('hidden'); });
  syncPauseButton();

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
