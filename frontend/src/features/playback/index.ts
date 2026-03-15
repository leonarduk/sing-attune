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
import { beatToMs, postPlayback, setPlaybackTempo, startPlayback, seekPlayback } from '../../transport/controls';
import { sessionSummaryTracker, type SessionSummary } from '../../practice/session-summary';
import { type Feature } from '../../feature-types';
import { ensureAudioPreflightReady } from '../../services/audio-preflight';
import { clearLoopRegion, getLoopRegion, setLoopEnd, setLoopStart } from '../../services/loop-region';

// ── Cursor RAF ──────────────────────────────────────────────────────────────────


async function restartLoopPlayback(): Promise<void> {
  const session = getSession();
  if (!session) return;
  const region = getLoopRegion();
  if (!region.active) return;

  const { engine, cursor, model } = session;
  const targetBeat = Math.max(0, Math.min(model.total_beats, region.startBeat));
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
    setStatus(`loop seek failed: ${String(err)}`, 'error');
    console.error('Loop seek failed:', err);
    return;
  }

  engine.seekToBeat(targetBeat);
  cursor.seekToBeat(targetBeat);
}

let cursorRafId: number | null = null;
let unsubscribeScoreLoaded: (() => void) | null = null;
let unsubscribeScoreCleared: (() => void) | null = null;
let removeKeydownListener: (() => void) | null = null;
let loopSeekInFlight = false;

function startCursorRaf(): void {
  stopCursorRaf();
  function tick(): void {
    const session = getSession();
    if (session?.engine.playing && session.cursor) {
      const beat = session.engine.currentBeat;
      const region = getLoopRegion();

      if (region.active && beat >= region.endBeat && !loopSeekInFlight) {
        loopSeekInFlight = true;
        void restartLoopPlayback().finally(() => {
          loopSeekInFlight = false;
        });
      }

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
  loopSeekInFlight = false;
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



async function adjustTempoByStep(stepPercent: number): Promise<void> {
  const session = getSession();
  if (!session) return;

  const tempoSliderEl = document.getElementById('tempo-slider') as HTMLInputElement | null;
  const tempoLabelEl = document.getElementById('tempo-label') as HTMLSpanElement | null;
  if (!tempoSliderEl || !tempoLabelEl) return;

  const currentPercent = parseInt(tempoSliderEl.value, 10);
  if (Number.isNaN(currentPercent)) return;

  const nextPercent = Math.max(50, Math.min(125, currentPercent + stepPercent));
  if (nextPercent === currentPercent) return;

  const previousMultiplier = session.engine.tempoMultiplier;
  const nextMultiplier = nextPercent / 100;

  tempoSliderEl.value = String(nextPercent);
  tempoLabelEl.textContent = `${nextPercent}%`;

  session.engine.setTempoMultiplier(nextMultiplier);
  try {
    await setPlaybackTempo(nextMultiplier);
  } catch (err) {
    session.engine.setTempoMultiplier(previousMultiplier);
    const previousPercent = Math.round(previousMultiplier * 100);
    tempoSliderEl.value = String(previousPercent);
    tempoLabelEl.textContent = `${previousPercent}%`;
    setStatus(`tempo update failed: ${String(err)}`, 'error');
    console.error('Tempo update failed:', err);
  }
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


  function syncTransportButtons(): void {
    const session = getSession();

    // Play: enabled only when a score is loaded and not already playing.
    if (!session || session.engine.state === 'playing') {
      btnPlay.disabled = true;
    } else {
      btnPlay.disabled = false;
    }

    // Pause/Resume: enabled when playing or paused.
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

  const unsubscribeLoaded = onScoreLoaded(() => { syncTransportButtons(); });
  const unsubscribeCleared = onScoreCleared(() => {
    stopCursorRaf();
    finishPracticeSessionCapture();
    clearLoopRegion();
    syncTransportButtons();
  });

  function syncPauseButton(): void {
    const session = getSession();
    if (!session || session.engine.state === 'idle') {
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
    }
  }

  unsubscribeScoreLoaded?.();
  unsubscribeScoreCleared?.();
  unsubscribeScoreLoaded = onScoreLoaded(() => { syncTransportButtons(); });
  unsubscribeScoreCleared = onScoreCleared(() => {
    stopCursorRaf();
    finishPracticeSessionCapture();
    clearLoopRegion();
    syncTransportButtons();
  });

  btnPlay.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    const { engine, cursor } = session;
    if (engine.state === 'playing') return;
    const preflightReady = await ensureAudioPreflightReady();
    if (!preflightReady) {
      setStatus('Audio setup is required before starting playback.', 'error');
      return;
    }
    headphoneWarning.classList.remove('hidden');
    const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;
    try {
      hideSessionSummary();
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
        sessionSummaryTracker.startSession();
        startPracticeSessionCapture(session.model.title, session.selectedPart);
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
      syncTransportButtons();
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
      syncTransportButtons();
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
      const summary = sessionSummaryTracker.finishSession();
      if (summary) showSessionSummary(summary);
      syncPauseButton();
      syncTransportButtons();
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
    sessionSummaryTracker.reset();
    hideSessionSummary();
    syncPauseButton();
    syncTransportButtons();
  });

  warningDismiss.addEventListener('click', () => { headphoneWarning.classList.add('hidden'); });
  summaryClose.addEventListener('click', () => { hideSessionSummary(); });

  // Replay: rewind and play again, preserving session stats for review.
  summaryReplay.addEventListener('click', () => {
    hideSessionSummary();
    btnRewind.click();
    btnPlay.click();
  });

  // Retry: reset session stats for a clean attempt, then rewind and play.
  summaryRetry.addEventListener('click', () => {
    hideSessionSummary();
    sessionSummaryTracker.reset();
    btnRewind.click();
    btnPlay.click();
  });

  syncPauseButton();
  syncTransportButtons();

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const session = getSession();
    if (!session) return;

    if (e.code === 'Escape') {
      e.preventDefault();
      clearLoopRegion();
      return;
    }
    if (e.code === 'KeyL') {
      e.preventDefault();
      const beat = session.engine.currentBeat;
      if (e.shiftKey) {
        setLoopEnd(beat);
      } else {
        setLoopStart(beat);
      }
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (session.engine.state === 'playing') { btnPause.click(); } else { btnPlay.click(); }
      return;
    }
    if (e.code === 'KeyR') { e.preventDefault(); if (!btnRewind.disabled) btnRewind.click(); return; }
    if (e.code === 'ArrowLeft')  { e.preventDefault(); if (session.engine.state !== 'playing') void seekByBeats(-1); return; }
    if (e.code === 'ArrowRight') { e.preventDefault(); if (session.engine.state !== 'playing') void seekByBeats(1); return; }
    if (e.key === '[') { e.preventDefault(); void adjustTempoByStep(-5); return; }
    if (e.key === ']') { e.preventDefault(); void adjustTempoByStep(5); }
  };
  window.addEventListener('keydown', onKeydown);

  removeKeydownListener = () => {
    window.removeEventListener('keydown', onKeydown);
    unsubscribeLoaded();
    unsubscribeCleared();
  };
}

function unmount(): void {
  stopCursorRaf();
  unsubscribeScoreLoaded?.();
  unsubscribeScoreLoaded = null;
  unsubscribeScoreCleared?.();
  unsubscribeScoreCleared = null;
  removeKeydownListener?.();
  removeKeydownListener = null;
}

export const playbackFeature: Feature = {
  id: 'slot-playback',
  mount,
  unmount,
};
