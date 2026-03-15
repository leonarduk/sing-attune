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
import { onPartChanged, onScoreCleared, onScoreLoaded, getSession } from '../../services/score-session';
import { setAppStatus } from '../../services/status';
import { recordBeatSample, resetProjection, getCursorX } from '../../services/cursor-projection';
import { finishPracticeSessionCapture, startPracticeSessionCapture } from '../../services/progress-history';
import { emitPlaybackSyncEvent } from '../../services/playback-sync';
import { beatToMs, postPlayback, startPlayback, seekPlayback } from '../../transport/controls';
import { sessionSummaryTracker, type SessionSummary } from '../../practice/session-summary';
import { type Feature } from '../../feature-types';
import { ensureAudioPreflightReady } from '../../services/audio-preflight';
import { clearLoopRegion, getLoopRegion, setLoopEnd, setLoopStart } from '../../services/loop-region';
import { installMediaSession, updateMediaSessionMetadata, updateMediaSessionState } from '../../media-session';
import { applyTempoChange } from '../../services/tempo';
import {
  buildSessionCsv,
  isSessionRecordingEnabled,
  sessionStats,
  setSessionRecordingEnabled,
  startSessionRecording,
  stopSessionRecording,
} from '../../services/session-recording';

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
    setAppStatus(`loop seek failed: ${String(err)}`, 'error');
    console.error('Loop seek failed:', err);
    return;
  }

  engine.seekToBeat(targetBeat);
  cursor.seekToBeat(targetBeat);
}

let cursorRafId: number | null = null;
let unsubscribeScoreLoaded: (() => void) | null = null;
let unsubscribeScoreCleared: (() => void) | null = null;
let unsubscribePartChanged: (() => void) | null = null;
let removeKeydownListener: (() => void) | null = null;
let loopSeekInFlight = false;

function getCurrentBpm(): number {
  const session = getSession();
  if (!session) return 120;
  const firstTempoMark = session.model.tempo_marks[0];
  return firstTempoMark?.bpm ?? 120;
}

function secondsToBeats(seconds: number): number {
  const session = getSession();
  if (!session) return 0;
  const bpm = getCurrentBpm();
  return seconds * (bpm * session.engine.tempoMultiplier / 60);
}

async function seekToBeat(targetBeat: number): Promise<void> {
  const session = getSession();
  if (!session) return;
  const { engine, cursor, model } = session;
  const clampedBeat = Math.max(0, Math.min(model.total_beats, targetBeat));
  try {
    const audioTimeSec = engine.ctx.currentTime;
    const response = await seekPlayback(beatToMs(clampedBeat, model, engine.tempoMultiplier));
    emitPlaybackSyncEvent({
      type: 'seek',
      tMs: response.t_ms,
      audioTimeSec,
      syncOffsetMs: null,
    });
  } catch (err) {
    setAppStatus(`seek failed: ${String(err)}`, 'error');
    console.error('Seek failed:', err);
    return;
  }

  engine.seekToBeat(clampedBeat);
  cursor.seekToBeat(clampedBeat);
  if (engine.state !== 'playing') stopCursorRaf();
}

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
  const { engine, model } = session;
  const stepBeats = model.time_signatures[0]?.numerator ?? 4;
  const targetBeat = Math.max(0,
    Math.min(model.total_beats, engine.currentBeat + delta * stepBeats));
  await seekToBeat(targetBeat);
}



async function adjustTempoByStep(stepPercent: number): Promise<void> {
  const tempoSliderEl = document.getElementById('tempo-slider') as HTMLInputElement | null;
  if (!tempoSliderEl) return;

  const currentPercent = parseInt(tempoSliderEl.value, 10);
  if (Number.isNaN(currentPercent)) return;

  await applyTempoChange(currentPercent + stepPercent);
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

function setPauseButtonState(button: HTMLButtonElement, state: 'idle' | 'playing' | 'paused'): void {
  if (state === 'playing') {
    button.disabled = false;
    button.innerHTML = '&#9646;&#9646; Pause (Space)';
    return;
  }

  if (state === 'paused') {
    button.disabled = false;
    button.innerHTML = '&#9654; Resume (Space)';
    return;
  }

  button.disabled = true;
  button.innerHTML = '&#9646;&#9646; Pause';
}

function isSessionSummaryOpen(): boolean {
  const modal = document.getElementById('session-summary-modal') as HTMLDivElement | null;
  return Boolean(modal && !modal.classList.contains('hidden'));
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
  const btnSessionRecord = document.getElementById('btn-session-record') as HTMLButtonElement | null;
  const btnSessionReview = document.getElementById('btn-session-review') as HTMLButtonElement | null;
  const btnSessionCsv    = document.getElementById('btn-session-csv')    as HTMLButtonElement | null;


  function syncSessionRecordingButton(): void {
    if (!btnSessionRecord) return;
    const active = isSessionRecordingEnabled();
    btnSessionRecord.textContent = active ? '⏺ Recording ON' : '⏺ Record session';
    btnSessionRecord.classList.toggle('active', active);
  }

  installMediaSession({
    play: () => {
      const session = getSession();
      if (!session || session.engine.state === 'playing') return;
      btnPlay.click();
    },
    pause: () => {
      const session = getSession();
      if (!session || session.engine.state !== 'playing') return;
      btnPause.click();
    },
    stop: () => {
      const session = getSession();
      if (!session) return;
      btnStop.click();
    },
    seekTo: (seconds) => {
      void seekToBeat(secondsToBeats(seconds));
    },
  });


  function syncTransportButtons(): void {
    const session = getSession();
    const playbackState = session?.engine.state ?? 'idle';
    const canTransport = playbackState === 'playing' || playbackState === 'paused';

    // Play: enabled only when a score is loaded and not already playing.
    if (!session || playbackState === 'playing') {
      btnPlay.disabled = true;
    } else {
      btnPlay.disabled = false;
    }

    // Stop/Rewind: enabled only while transport is active (playing/paused).
    btnStop.disabled = !canTransport;
    btnRewind.disabled = !canTransport;

    // Pause/Resume: enabled when playing or paused.
    if (!session) {
      setPauseButtonState(btnPause, 'idle');
      return;
    }
    setPauseButtonState(btnPause, playbackState);
  }

  const unsubscribeLoaded = onScoreLoaded((session) => {
    updateMediaSessionMetadata(session.model.title, session.selectedPart);
    syncTransportButtons();
  });
  const unsubscribeCleared = onScoreCleared(() => {
    stopCursorRaf();
    finishPracticeSessionCapture();
    clearLoopRegion();
    updateMediaSessionState('none');
    syncTransportButtons();
  });

  function syncPauseButton(): void {
    const session = getSession();
    if (!session || session.engine.state === 'idle') {
      setPauseButtonState(btnPause, 'idle');
      return;
    }
    if (session.engine.state === 'playing') {
      setPauseButtonState(btnPause, 'playing');
      return;
    }
    if (session.engine.state === 'paused') {
      setPauseButtonState(btnPause, 'paused');
    }
  }

  unsubscribeScoreLoaded?.();
  unsubscribeScoreCleared?.();
  unsubscribePartChanged?.();
  unsubscribeScoreLoaded = onScoreLoaded((session) => {
    updateMediaSessionMetadata(session.model.title, session.selectedPart);
    syncTransportButtons();
  });
  unsubscribePartChanged = onPartChanged((session) => {
    updateMediaSessionMetadata(session.model.title, session.selectedPart);
  });
  unsubscribeScoreCleared = onScoreCleared(() => {
    stopCursorRaf();
    finishPracticeSessionCapture();
    clearLoopRegion();
    updateMediaSessionState('none');
    syncTransportButtons();
  });

  btnPlay.addEventListener('click', async () => {
    const session = getSession();
    if (!session) {
      setAppStatus('Load a score first', 'warning');
      return;
    }
    const { engine, cursor } = session;
    if (engine.state === 'playing') return;
    const preflightReady = await ensureAudioPreflightReady();
    if (!preflightReady) {
      setAppStatus('Audio setup is required before starting playback.', 'error');
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
        startSessionRecording({
          title: session.model.title,
          part: session.selectedPart,
          tempoMarks: session.model.tempo_marks,
          notes: session.model.notes.filter((note) => note.part === session.selectedPart),
        });
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
      updateMediaSessionState('playing');
      startCursorRaf();
      syncTransportButtons();
    } catch (err) {
      setAppStatus(`playback start failed: ${String(err)}`, 'error');
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
        updateMediaSessionState('paused');
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
        updateMediaSessionState('playing');
        startCursorRaf();
      }
      syncTransportButtons();
    } catch (err) {
      setAppStatus(`pause failed: ${String(err)}`, 'error');
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
      updateMediaSessionState('none');
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
      const recorded = stopSessionRecording();
      if (recorded) {
        const saveRes = await fetch('/session/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recorded),
        }).catch(() => null);
        if (saveRes?.ok) {
          const stats = sessionStats(recorded);
          setAppStatus(`session saved · ≤50c ${stats.within50Pct.toFixed(0)}% · ≤100c ${stats.within100Pct.toFixed(0)}%`, 'success');
        }
      }
      syncPauseButton();
      syncTransportButtons();
    } catch (err) {
      setAppStatus(`stop failed: ${String(err)}`, 'error');
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
      setAppStatus(`rewind failed: ${String(err)}`, 'error');
      console.error('Rewind failed:', err);
    }
    session.engine.stop();
    updateMediaSessionState('none');
    finishPracticeSessionCapture();
    stopCursorRaf();
    session.cursor.stop();
    session.cursor.osmd.cursor.show();
    headphoneWarning.classList.add('hidden');
    sessionSummaryTracker.reset();
    stopSessionRecording();
    hideSessionSummary();
    syncPauseButton();
    syncTransportButtons();
  });

  warningDismiss.addEventListener('click', () => { headphoneWarning.classList.add('hidden'); });
  summaryClose.addEventListener('click', () => { hideSessionSummary(); });

  btnSessionRecord?.addEventListener('click', () => {
    setSessionRecordingEnabled(!isSessionRecordingEnabled());
    syncSessionRecordingButton();
  });

  btnSessionReview?.addEventListener('click', async () => {
    const res = await fetch('/session/list').catch(() => null);
    if (!res?.ok) return;
    const listPayload = (await res.json()) as { sessions: Array<{ id: string }> };
    const latest = listPayload.sessions[0];
    if (!latest) return;
    const sessionRes = await fetch(`/session/${latest.id}`).catch(() => null);
    if (!sessionRes?.ok) return;
    const sessionPayload = (await sessionRes.json()) as {
      frames: Array<{ t: number; midi: number; conf: number }>;
    };
    const frames = sessionPayload.frames;
    if (frames.length === 0) return;

    window.dispatchEvent(new CustomEvent('session-review-clear'));

    // Schedule each frame at the correct wall-clock offset based on frame.t
    // (milliseconds since playback started), so replay matches original speed.
    const replayStart = performance.now();
    function scheduleFrame(idx: number): void {
      if (idx >= frames.length) return;
      const frame = frames[idx];
      const delay = Math.max(0, frame.t - (performance.now() - replayStart));
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('session-review-frame', { detail: frame }));
        scheduleFrame(idx + 1);
      }, delay);
    }
    scheduleFrame(0);
  });

  btnSessionCsv?.addEventListener('click', async () => {
    const res = await fetch('/session/list').catch(() => null);
    if (!res?.ok) return;
    const listPayload = (await res.json()) as { sessions: Array<{ id: string }> };
    const latest = listPayload.sessions[0];
    if (!latest) return;
    const sessionRes = await fetch(`/session/${latest.id}`).catch(() => null);
    if (!sessionRes?.ok) return;
    const sessionPayload = (await sessionRes.json()) as {
      frames: Array<{ t: number; beat: number; midi: number | null; conf: number; expected_midi: number | null; measure: number | null }>;
    };
    const csv = buildSessionCsv(sessionPayload);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'session_export.csv';
    link.click();
    URL.revokeObjectURL(url);
  });

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
  syncSessionRecordingButton();

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.code === 'Escape' && isSessionSummaryOpen()) {
      e.preventDefault();
      hideSessionSummary();
      return;
    }

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
  unsubscribePartChanged?.();
  unsubscribePartChanged = null;
  removeKeydownListener?.();
  removeKeydownListener = null;
}

export const playbackFeature: Feature = {
  id: 'slot-playback',
  mount,
  unmount,
};
