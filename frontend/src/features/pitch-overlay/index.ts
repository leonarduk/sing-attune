/**
 * pitch-overlay feature
 *
 * Owns:
 *   - WebSocket connection to /ws/pitch
 *   - PitchOverlay (score annotation)
 *   - PitchGraphCanvas (rolling pitch graph)
 *   - Settings panel (gear button + all controls inside it)
 *   - PracticeRecorder
 *   - Pitch readout (#pitch-readout)
 *
 * Reacts to score-session lifecycle and selectedPart changes via
 * onScoreLoaded / onScoreCleared.
 *
 * Imports getFrameXPosition from services/cursor-projection (not from the
 * playback feature) to preserve feature isolation.
 */
import { onScoreLoaded, onScoreCleared, getSession } from '../../services/score-session';
import { onPlaybackSyncEvent } from '../../services/playback-sync';
import { showErrorBanner } from '../../services/backend';
import { getFrameXPosition } from '../../services/cursor-projection';
import { MIN_CONFIDENCE_THRESHOLD, PitchOverlay, type OverlaySettings } from '../../pitch/overlay';
import { PitchGraphCanvas } from '../../pitch/graph';
import { expectedNoteAtBeat } from '../../pitch/accuracy';
import { syntheticPitchFrameAt } from '../../pitch/synthetic';
import { buildWarmupSequence, warmupMidiAt, WarmupTonePlayer, type WarmupSegment } from '../../warmup/session';
import { parsePitchFrame, reconnectDelayMs } from '../../pitch/socket';
import { PitchTimelineSync } from '../../pitch/timeline-sync';
import { parsePitchSocketMessage, reconnectDelayMs } from '../../pitch/socket';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { elapsedToBeat } from '../../score/timing';
import { type NoteModel } from '../../score/renderer';
import { PhraseSummaryTracker, type PhraseSummary } from '../../pitch/phrase-summary';
import { resolveSelectedDeviceId, type AudioInputDevice } from '../../audio/devices';
import { PracticeRecorder } from '../../audio/recorder';
import { type Feature } from '../../feature-types';

// ── Module-level singletons (survive score reloads) ───────────────────────────

const practiceRecorder = new PracticeRecorder();

let pitchGraph: PitchGraphCanvas | null = null;
let pitchGraphRafId: number | null = null;
let pitchGraphNowSec = 0;

let pitchWs: WebSocket | null = null;
let pitchReconnectTimer: number | null = null;
let shouldReconnectPitchSocket = false;
let pitchReconnectAttempts = 0;

let pitchOverlay: PitchOverlay | null = null;
let lastPitchFrame: { midi: number } | null = null;
let activePartNotes: NoteModel[] = [];
let showNoteNames = false;
let syntheticModeEnabled = false;
let selectedDeviceId: number | null = null;
let recordingError: string | null = null;
let phraseSummaryTracker: PhraseSummaryTracker | null = null;
const timelineSync = new PitchTimelineSync();
let playbackSyncUnsubscribe: (() => void) | null = null;
let syncOffsetWarningShown = false;

let warmupActive = false;
let warmupStartPerfMs = 0;
let warmupDurationSec = 120;
let warmupSequence: WarmupSegment[] = [];
let warmupTargetMidi: number | null = null;
const warmupTonePlayer = new WarmupTonePlayer();

const overlaySettings: OverlaySettings = {
  confidenceThreshold: MIN_CONFIDENCE_THRESHOLD,
  trailMs: 2000,
};

// ── Pitch readout ────────────────────────────────────────────────────────────

function updatePitchReadout(): void {
  const el = document.getElementById('pitch-readout') as HTMLSpanElement;
  if (!lastPitchFrame) { el.textContent = 'Detected: —'; return; }
  const hz = midiToFrequency(lastPitchFrame.midi);
  const freqLabel = `${hz.toFixed(2)} Hz`;
  if (!showNoteNames) { el.textContent = `Detected: ${freqLabel}`; return; }
  el.textContent = `Detected: ${freqLabel} → ${midiToNoteName(lastPitchFrame.midi)}`;
}


function syncWarmupUi(message?: string): void {
  const warmupStatusEl = document.getElementById('warmup-status') as HTMLSpanElement | null;
  const btnStartWarmup = document.getElementById('btn-start-warmup') as HTMLButtonElement | null;
  const btnStartRehearsal = document.getElementById('btn-start-rehearsal') as HTMLButtonElement | null;
  if (warmupStatusEl && message !== undefined) warmupStatusEl.textContent = message;
  if (btnStartWarmup) btnStartWarmup.disabled = warmupActive;
  if (btnStartRehearsal) btnStartRehearsal.classList.toggle('hidden', warmupActive || warmupSequence.length === 0);
}

// ── Pitch frame handling ───────────────────────────────────────────────────

function expectedMidiForFrame(frameTMs: number): number | null {
  if (warmupActive) return warmupTargetMidi;
  const session = getSession();
  if (!session || activePartNotes.length === 0) return null;
  const beat = elapsedToBeat(frameTMs, 0, session.model.tempo_marks);
  return expectedNoteAtBeat(beat, activePartNotes)?.midi ?? null;
}

function handleIncomingPitchFrame(frame: { t: number; midi: number; conf: number }): void {
  const session = getSession();
  if (session) {
    const staleWindowMs = Math.max(2000, overlaySettings.trailMs * 1.5);
    if (timelineSync.isFrameStale(frame.t, session.engine.ctx.currentTime, staleWindowMs)) {
      return;
    }
  }

  lastPitchFrame = { midi: frame.midi };
  updatePitchReadout();
  const frameSec = frame.t / 1000;
  if (Number.isFinite(frameSec) && frameSec >= 0) {
    pitchGraphNowSec = Math.max(pitchGraphNowSec, frameSec);
  }
  pitchOverlay?.pushFrame(frame, getFrameXPosition(frame.t));
  pitchGraph?.pushFrame(frame, expectedMidiForFrame(frame.t));
  const completedPhrases = phraseSummaryTracker?.pushFrame(frame) ?? [];
  // Render all completed summaries — multiple can flush in a single frame after
  // a seek or discontinuity. Only the last one will remain visible, but each
  // call updates the panel so the most-recently-completed phrase is shown.
  for (const summary of completedPhrases) {
    renderPhraseSummary(summary);
  }
}

function clearPhraseSummaryPanel(): void {
  const panel = document.getElementById('phrase-summary-panel') as HTMLDivElement | null;
  if (!panel) return;
  panel.innerHTML = '<p class="phrase-summary-empty">Phrase summary will appear after a phrase completes.</p>';
}

function renderPhraseSummary(summary: PhraseSummary): void {
  const panel = document.getElementById('phrase-summary-panel') as HTMLDivElement | null;
  if (!panel) return;

  const notesHtml = summary.noteSummaries.map((note) => {
    const cents = note.meanCents > 0 ? `+${note.meanCents.toFixed(0)}c` : `${note.meanCents.toFixed(0)}c`;
    const direction = note.direction === 'neutral' ? 'neutral' : `${note.direction} ${cents}`;
    return `<span class="phrase-badge phrase-badge-${note.badge}">${note.label} ${badgeEmoji(note.badge)} · ${direction}</span>`;
  }).join('');

  panel.innerHTML = `
    <div class="phrase-summary-card">
      <div class="phrase-summary-title">Phrase ${summary.phraseId} · ${summary.withinTolerancePct.toFixed(0)}% in tolerance</div>
      <div class="phrase-summary-notes">${notesHtml}</div>
      <div class="phrase-summary-legend">🟢 ≤50c · 🟡 51–100c · 🔴 &gt;100c</div>
    </div>
  `;
}

function badgeEmoji(badge: 'green' | 'amber' | 'red'): string {
  if (badge === 'green') return '🟢';
  if (badge === 'amber') return '🟡';
  return '🔴';
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function closePitchSocket(): void {
  shouldReconnectPitchSocket = false;
  pitchReconnectAttempts = 0;
  if (pitchReconnectTimer !== null) { window.clearTimeout(pitchReconnectTimer); pitchReconnectTimer = null; }
  pitchWs?.close();
  pitchWs = null;
}

function bindPlaybackSync(): void {
  playbackSyncUnsubscribe?.();
  playbackSyncUnsubscribe = onPlaybackSyncEvent((event) => {
    if (event.type === 'stop') {
      timelineSync.reset();
      pitchOverlay?.clear();
      pitchGraph?.clear();
      return;
    }
    if (event.type === 'pause') {
      return;
    }
    if (event.syncOffsetMs === null && !syncOffsetWarningShown) {
      console.warn('Pitch sync offset unavailable; using default offset 0ms until protocol in issue #27 is implemented.');
      syncOffsetWarningShown = true;
    }
    timelineSync.setSyncOffsetMs(event.syncOffsetMs ?? 0);
    // Use audioTimeSec (AudioContext seconds) as the graph scroll cursor —
    // event.tMs is backend-relative milliseconds and must not be used here.
    pitchGraphNowSec = event.audioTimeSec;
    timelineSync.reanchor(event.tMs, event.audioTimeSec);
    pitchOverlay?.clear();
    pitchGraph?.clear();
  });
}

function connectPitchSocket(): void {
  if (syntheticModeEnabled) return;
  shouldReconnectPitchSocket = true;
  if (pitchReconnectTimer !== null) { window.clearTimeout(pitchReconnectTimer); pitchReconnectTimer = null; }
  if (pitchWs && (pitchWs.readyState === WebSocket.OPEN ||
                  pitchWs.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  pitchWs = new WebSocket(`${protocol}://${window.location.host}/ws/pitch`);
  pitchWs.onopen  = () => { pitchReconnectAttempts = 0; };
  pitchWs.onerror = () => { pitchWs?.close(); };
  pitchWs.onclose = () => {
    pitchWs = null;
    if (!shouldReconnectPitchSocket) return;
    pitchReconnectAttempts += 1;
    pitchReconnectTimer = window.setTimeout(() => {
      pitchReconnectTimer = null;
      connectPitchSocket();
    }, reconnectDelayMs(pitchReconnectAttempts));
  };
  pitchWs.onmessage = (event) => {
    if (syntheticModeEnabled) return;
    let payload: unknown;
    try { payload = JSON.parse(event.data) as unknown; } catch { return; }
    const message = parsePitchSocketMessage(payload);
    if (message.kind === 'frame') handleIncomingPitchFrame(message.frame);
  };
}

// ── Pitch graph RAF loop ─────────────────────────────────────────────────────

function startPitchGraphLoop(): void {
  if (pitchGraphRafId !== null) return;
  const tick = (): void => {
    const session = getSession();
    const warmupElapsedMs = performance.now() - warmupStartPerfMs;
    if (warmupActive) {
      warmupTargetMidi = warmupMidiAt(warmupElapsedMs, warmupSequence);
      if (warmupTargetMidi !== null) {
        const seg = warmupSequence.find((item) => warmupElapsedMs >= item.startMs && warmupElapsedMs < item.endMs);
        if (seg) syncWarmupUi(`Warm-up in progress: ${seg.exercise}`);
        warmupTonePlayer.playExpectedMidi(warmupTargetMidi);
      } else {
        warmupActive = false;
        warmupTargetMidi = null;
        syncWarmupUi('Warm-up complete. You can start rehearsal.');
        setStatus('warm-up complete', 'ok');
      }
    }
    if (syntheticModeEnabled && (session?.engine.playing || warmupActive)) {
      const elapsedSec = session?.engine.playing
        ? Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime)
        : warmupElapsedMs / 1000;
      handleIncomingPitchFrame(syntheticPitchFrameAt(elapsedSec, expectedMidiForFrame(elapsedSec * 1000)));
    }
    if (session?.engine.playing) {
      const playbackSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      pitchGraphNowSec = Math.max(pitchGraphNowSec, playbackSec);
    }
    pitchGraph?.tick(pitchGraphNowSec);
    pitchGraphRafId = requestAnimationFrame(tick);
  };
  pitchGraphRafId = requestAnimationFrame(tick);
}

function stopPitchGraphLoop(): void {
  if (pitchGraphRafId === null) return;
  cancelAnimationFrame(pitchGraphRafId);
  pitchGraphRafId = null;
}

// ── Recording ───────────────────────────────────────────────────────────────

function setRecordingStatus(msg: string): void {
  (document.getElementById('recording-status') as HTMLDivElement).textContent = msg;
}

interface RecordingCtrl {
  enabled: HTMLInputElement;
  start: HTMLButtonElement; stop: HTMLButtonElement;
  play: HTMLButtonElement;  save: HTMLButtonElement;
  discard: HTMLButtonElement;
}

function refreshRecordingControls(ctrl: RecordingCtrl): void {
  const enabled = ctrl.enabled.checked;
  const supported = PracticeRecorder.isSupported();
  const state = practiceRecorder.state;
  ctrl.start.disabled   = !enabled || !supported || state === 'recording';
  ctrl.stop.disabled    = !enabled || !supported || state !== 'recording';
  ctrl.play.disabled    = !enabled || !supported || state !== 'recorded';
  ctrl.save.disabled    = !enabled || !supported || state !== 'recorded';
  ctrl.discard.disabled = !enabled || !supported || state === 'idle';
  if (!enabled)   { setRecordingStatus('Recording disabled.'); return; }
  if (!supported) { setRecordingStatus('Recording unsupported in this browser.'); return; }
  if (recordingError) { setRecordingStatus(recordingError); return; }
  if (state === 'idle')      setRecordingStatus('Ready to record.');
  if (state === 'recording') setRecordingStatus('Recording…');
  if (state === 'recorded')  setRecordingStatus('Take captured.');
}

// ── Settings: audio devices ────────────────────────────────────────────────────

async function refreshAudioSettings(
  settingsDeviceEl: HTMLSelectElement,
  settingsEngineEl: HTMLDivElement,
): Promise<void> {
  try {
    const [devicesRes, engineRes] = await Promise.all([fetch('/audio/devices'), fetch('/audio/engine')]);
    if (!devicesRes.ok) throw new Error(`/audio/devices HTTP ${devicesRes.status}`);
    const devicesPayload = (await devicesRes.json()) as {
      default_device_id: number | null; devices: AudioInputDevice[];
    };
    settingsDeviceEl.innerHTML = devicesPayload.devices
      .map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
    selectedDeviceId = resolveSelectedDeviceId({
      devices: devicesPayload.devices,
      defaultDeviceId: devicesPayload.default_device_id,
      persistedDeviceId: selectedDeviceId,
    });
    settingsDeviceEl.value = selectedDeviceId === null ? '' : String(selectedDeviceId);
    settingsDeviceEl.disabled = devicesPayload.devices.length === 0;
    if (engineRes.ok) {
      const ep = (await engineRes.json()) as { active_engine: string; mode: string };
      settingsEngineEl.textContent = `Pitch engine: ${ep.active_engine} (${ep.mode})`;
    } else {
      settingsEngineEl.textContent = 'Pitch engine: unavailable';
    }
  } catch (err) {
    settingsDeviceEl.innerHTML = '';
    settingsDeviceEl.disabled = true;
    selectedDeviceId = null;
    settingsEngineEl.textContent = 'Pitch engine: unavailable';
    showErrorBanner('Unable to load audio devices. Check backend audio permissions and retry.');
    console.error('Failed to load settings data:', err);
  }
}

// ── mount ─────────────────────────────────────────────────────────────────

function mount(_slot: HTMLElement): void {
  const scoreContainerEl    = document.getElementById('score-container')           as HTMLDivElement;
  const warmupDurationEl    = document.getElementById('warmup-duration')           as HTMLSelectElement;
  const btnStartWarmup      = document.getElementById('btn-start-warmup')          as HTMLButtonElement;
  const btnStartRehearsal   = document.getElementById('btn-start-rehearsal')       as HTMLButtonElement;
  const pitchGraphCanvasEl  = document.getElementById('pitch-graph-canvas')        as HTMLDivElement;
  const settingsPanelEl     = document.getElementById('settings-panel')            as HTMLDivElement;
  const btnSettings         = document.getElementById('btn-settings')              as HTMLButtonElement;
  const settingsDeviceEl    = document.getElementById('settings-device')          as HTMLSelectElement;
  const settingsConfEl      = document.getElementById('settings-confidence')      as HTMLInputElement;
  const settingsConfLabelEl = document.getElementById('settings-confidence-label') as HTMLSpanElement;
  const settingsTrailEl     = document.getElementById('settings-trail')            as HTMLInputElement;
  const settingsTrailLabelEl = document.getElementById('settings-trail-label')    as HTMLSpanElement;
  const settingsNoteNamesEl = document.getElementById('settings-show-note-names') as HTMLInputElement;
  const settingsSynthEl     = document.getElementById('settings-synthetic-mode')  as HTMLInputElement;
  const settingsEngineEl    = document.getElementById('settings-engine')           as HTMLDivElement;
  const recordingEnabledEl  = document.getElementById('recording-enabled')        as HTMLInputElement;
  const btnStop             = document.getElementById('btn-stop')                 as HTMLButtonElement;
  const btnRewind           = document.getElementById('btn-rewind')               as HTMLButtonElement;

  const ctrl: RecordingCtrl = {
    enabled: recordingEnabledEl,
    start:   document.getElementById('btn-record-start')   as HTMLButtonElement,
    stop:    document.getElementById('btn-record-stop')    as HTMLButtonElement,
    play:    document.getElementById('btn-record-play')    as HTMLButtonElement,
    save:    document.getElementById('btn-record-save')    as HTMLButtonElement,
    discard: document.getElementById('btn-record-discard') as HTMLButtonElement,
  };

  function updateSettingsLabels(): void {
    settingsConfLabelEl.textContent = overlaySettings.confidenceThreshold.toFixed(2);
    settingsTrailLabelEl.textContent = `${(overlaySettings.trailMs / 1000).toFixed(1)}s`;
  }

  function updateWarmupUi(message: string): void {
    syncWarmupUi(message);
  }

  function startWarmup(): void {
    warmupDurationSec = Number.parseInt(warmupDurationEl.value, 10) || 120;
    warmupSequence = buildWarmupSequence(warmupDurationSec, 60);
    warmupStartPerfMs = performance.now();
    warmupTargetMidi = warmupSequence[0]?.midi ?? null;
    warmupActive = true;
    setStatus('warm-up running', 'ok');
    updateWarmupUi('Warm-up in progress: sirens');
    connectPitchSocket();
  }

  pitchGraph = new PitchGraphCanvas(pitchGraphCanvasEl);
  bindPlaybackSync();
  startPitchGraphLoop();
  clearPhraseSummaryPanel();

  onScoreCleared(() => {
    closePitchSocket();
    pitchOverlay?.destroy();
    pitchOverlay = null;
    pitchGraph?.clear();
    timelineSync.reset();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    phraseSummaryTracker = null;
    clearPhraseSummaryPanel();
    updatePitchReadout();
  });

  onScoreLoaded((session) => {
    pitchOverlay?.destroy();
    pitchOverlay = new PitchOverlay(
      scoreContainerEl, session.model, session.selectedPart, overlaySettings);
    activePartNotes = session.model.notes.filter((n) => n.part === session.selectedPart);
    phraseSummaryTracker = new PhraseSummaryTracker(activePartNotes, session.model.tempo_marks);
    pitchGraph?.clear();
    timelineSync.reset();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    clearPhraseSummaryPanel();
    updatePitchReadout();
    connectPitchSocket();
  });

  btnStop.addEventListener('click', () => {
    phraseSummaryTracker?.reset();
    clearPhraseSummaryPanel();
  });
  btnRewind.addEventListener('click', () => {
    phraseSummaryTracker?.reset();
    clearPhraseSummaryPanel();
  });

  // Settings panel init
  settingsConfEl.value = String(overlaySettings.confidenceThreshold);
  settingsTrailEl.value = String(overlaySettings.trailMs / 1000);
  settingsNoteNamesEl.checked = showNoteNames;
  settingsSynthEl.checked = syntheticModeEnabled;
  updateSettingsLabels();
  updatePitchReadout();
  refreshRecordingControls(ctrl);
  updateWarmupUi('Warm-up idle.');

  btnSettings.addEventListener('click', async (event) => {
    event.stopPropagation();
    const visible = settingsPanelEl.classList.toggle('visible');
    if (visible) await refreshAudioSettings(settingsDeviceEl, settingsEngineEl);
  });
  settingsPanelEl.addEventListener('click', (e) => { e.stopPropagation(); });
  window.addEventListener('click', (e) => {
    if (!settingsPanelEl.classList.contains('visible')) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (settingsPanelEl.contains(target) || btnSettings.contains(target)) return;
    settingsPanelEl.classList.remove('visible');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') settingsPanelEl.classList.remove('visible');
  });
  settingsDeviceEl.addEventListener('change', () => {
    const v = settingsDeviceEl.value;
    if (v === '') { selectedDeviceId = null; return; }
    const p = Number.parseInt(v, 10);
    selectedDeviceId = Number.isNaN(p) ? null : p;
  });
  settingsConfEl.addEventListener('input', () => {
    overlaySettings.confidenceThreshold = parseFloat(settingsConfEl.value);
    pitchOverlay?.applySettings(overlaySettings);
    updateSettingsLabels();
  });
  settingsTrailEl.addEventListener('input', () => {
    overlaySettings.trailMs = parseFloat(settingsTrailEl.value) * 1000;
    pitchOverlay?.applySettings(overlaySettings);
    updateSettingsLabels();
  });
  settingsNoteNamesEl.addEventListener('change', () => {
    showNoteNames = settingsNoteNamesEl.checked;
    updatePitchReadout();
  });
  warmupDurationEl.addEventListener('change', () => {
    warmupDurationSec = Number.parseInt(warmupDurationEl.value, 10) || 120;
    if (!warmupActive) updateWarmupUi(`Warm-up idle (${warmupDurationSec}s configured).`);
  });
  btnStartWarmup.addEventListener('click', () => {
    startWarmup();
  });
  btnStartRehearsal.addEventListener('click', () => {
    const playBtn = document.getElementById('btn-play') as HTMLButtonElement | null;
    playBtn?.click();
  });

  settingsSynthEl.addEventListener('change', () => {
    syntheticModeEnabled = settingsSynthEl.checked;
    closePitchSocket();
    if (!syntheticModeEnabled) connectPitchSocket();
  });

  // Recording
  recordingEnabledEl.addEventListener('change', () => {
    if (!recordingEnabledEl.checked) practiceRecorder.discard();
    recordingError = null;
    refreshRecordingControls(ctrl);
  });
  ctrl.start.addEventListener('click', async () => {
    try {
      await practiceRecorder.start(); recordingError = null; refreshRecordingControls(ctrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordingError = msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('notallowed')
        ? 'Microphone permission denied. Recording remains off until access is granted.'
        : `Could not start recording: ${msg}`;
      refreshRecordingControls(ctrl);
    }
  });
  ctrl.stop.addEventListener('click', async () => {
    await practiceRecorder.stop(); recordingError = null; refreshRecordingControls(ctrl);
  });
  ctrl.play.addEventListener('click', () => {
    if (!practiceRecorder.playLastTake()) setRecordingStatus('No take to play yet.');
  });
  ctrl.save.addEventListener('click', async () => {
    try {
      const saved = await practiceRecorder.saveLastTake();
      setRecordingStatus(saved ? 'Take saved.' : 'No take to save yet.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRecordingStatus(msg.toLowerCase().includes('abort') ? 'Save cancelled.' : `Could not save take: ${msg}`);
    }
  });
  ctrl.discard.addEventListener('click', () => {
    practiceRecorder.discard(); recordingError = null; refreshRecordingControls(ctrl);
  });

  window.addEventListener('beforeunload', () => {
    closePitchSocket(); stopPitchGraphLoop();
    pitchOverlay?.destroy(); pitchGraph?.destroy(); practiceRecorder.destroy();
  });
}

function unmount(): void {
  playbackSyncUnsubscribe?.();
  playbackSyncUnsubscribe = null;
  closePitchSocket();
  stopPitchGraphLoop();
  pitchOverlay?.destroy(); pitchOverlay = null;
  pitchGraph?.destroy();   pitchGraph = null;
  practiceRecorder.destroy();
}

export const pitchOverlayFeature: Feature = {
  id: 'slot-pitch-overlay',
  mount,
  unmount,
};
