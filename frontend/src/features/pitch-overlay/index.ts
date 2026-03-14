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
import { showErrorBanner } from '../../services/backend';
import { getFrameXPosition } from '../../services/cursor-projection';
import { MIN_CONFIDENCE_THRESHOLD, PitchOverlay, type OverlaySettings } from '../../pitch/overlay';
import { PitchGraphCanvas } from '../../pitch/graph';
import { expectedNoteAtBeat } from '../../pitch/accuracy';
import { syntheticPitchFrameAt } from '../../pitch/synthetic';
import { parsePitchFrame, reconnectDelayMs } from '../../pitch/socket';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { SessionRangeTracker } from '../../pitch/session-range';
import { elapsedToBeat } from '../../score/timing';
import { type NoteModel } from '../../score/renderer';
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
let sessionRangeSummaryText = 'Last session range: —';
let wasPlayingLastTick = false;

const sessionRangeTracker = new SessionRangeTracker();

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

function updateSessionRangeReadout(): void {
  const el = document.getElementById('session-range-readout') as HTMLSpanElement;
  const summary = sessionRangeTracker.summary();
  if (!summary) {
    el.textContent = 'Session range: —';
    return;
  }
  const low = midiToNoteName(summary.lowMidi);
  const high = midiToNoteName(summary.highMidi);
  el.textContent = `Session range: ${low} → ${high} (${summary.semitoneSpan} st / ${summary.octaveSpan.toFixed(2)} oct)`;
}

function updateSessionRangeSummary(): void {
  const el = document.getElementById('session-range-summary') as HTMLSpanElement;
  el.textContent = sessionRangeSummaryText;
}

function finalizeSessionRangeSummary(): void {
  const summary = sessionRangeTracker.summary();
  if (!summary) {
    sessionRangeSummaryText = 'Last session range: no stable notes captured.';
  } else {
    const low = midiToNoteName(summary.lowMidi);
    const high = midiToNoteName(summary.highMidi);
    sessionRangeSummaryText =
      `Last session range: ${low} → ${high} (${summary.semitoneSpan} semitones, ${summary.octaveSpan.toFixed(2)} octaves)`;
  }
  updateSessionRangeSummary();
}

// ── Pitch frame handling ───────────────────────────────────────────────────

function expectedMidiForFrame(frameTMs: number): number | null {
  const session = getSession();
  if (!session || activePartNotes.length === 0) return null;
  const beat = elapsedToBeat(frameTMs, 0, session.model.tempo_marks);
  return expectedNoteAtBeat(beat, activePartNotes)?.midi ?? null;
}

function handleIncomingPitchFrame(frame: { t: number; midi: number; conf: number }): void {
  lastPitchFrame = { midi: frame.midi };
  updatePitchReadout();
  const frameSec = frame.t / 1000;
  if (Number.isFinite(frameSec) && frameSec >= 0) {
    pitchGraphNowSec = Math.max(pitchGraphNowSec, frameSec);
  }
  pitchOverlay?.pushFrame(frame, getFrameXPosition(frame.t));
  pitchGraph?.pushFrame(frame, expectedMidiForFrame(frame.t));
  if (sessionRangeTracker.ingest(frame, overlaySettings.confidenceThreshold)) {
    updateSessionRangeReadout();
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function closePitchSocket(): void {
  shouldReconnectPitchSocket = false;
  pitchReconnectAttempts = 0;
  if (pitchReconnectTimer !== null) { window.clearTimeout(pitchReconnectTimer); pitchReconnectTimer = null; }
  pitchWs?.close();
  pitchWs = null;
}

function connectPitchSocket(): void {
  if (!pitchOverlay || syntheticModeEnabled) return;
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
    if (!shouldReconnectPitchSocket || !pitchOverlay) return;
    pitchReconnectAttempts += 1;
    pitchReconnectTimer = window.setTimeout(() => {
      pitchReconnectTimer = null;
      connectPitchSocket();
    }, reconnectDelayMs(pitchReconnectAttempts));
  };
  pitchWs.onmessage = (event) => {
    if (!pitchOverlay || syntheticModeEnabled) return;
    let payload: unknown;
    try { payload = JSON.parse(event.data) as unknown; } catch { return; }
    const frame = parsePitchFrame(payload);
    if (frame) handleIncomingPitchFrame(frame);
  };
}

// ── Pitch graph RAF loop ─────────────────────────────────────────────────────

function startPitchGraphLoop(): void {
  if (pitchGraphRafId !== null) return;
  const tick = (): void => {
    const session = getSession();
    if (syntheticModeEnabled && session?.engine.playing) {
      const elapsedSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      handleIncomingPitchFrame(syntheticPitchFrameAt(elapsedSec, expectedMidiForFrame(elapsedSec * 1000)));
    }
    if (session?.engine.playing) {
      const playbackSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      pitchGraphNowSec = Math.max(pitchGraphNowSec, playbackSec);
    }
    const isPlaying = !!session?.engine.playing;
    if (wasPlayingLastTick && !isPlaying && sessionRangeTracker.hasRange()) {
      finalizeSessionRangeSummary();
    }
    wasPlayingLastTick = isPlaying;
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

  pitchGraph = new PitchGraphCanvas(pitchGraphCanvasEl);
  startPitchGraphLoop();

  onScoreCleared(() => {
    finalizeSessionRangeSummary();
    closePitchSocket();
    pitchOverlay?.destroy();
    pitchOverlay = null;
    pitchGraph?.clear();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    wasPlayingLastTick = false;
    sessionRangeTracker.reset();
    updatePitchReadout();
    updateSessionRangeReadout();
  });

  onScoreLoaded((session) => {
    pitchOverlay?.destroy();
    pitchOverlay = new PitchOverlay(
      scoreContainerEl, session.model, session.selectedPart, overlaySettings);
    activePartNotes = session.model.notes.filter((n) => n.part === session.selectedPart);
    pitchGraph?.clear();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    wasPlayingLastTick = false;
    sessionRangeTracker.reset();
    updatePitchReadout();
    updateSessionRangeReadout();
    connectPitchSocket();
  });

  // Settings panel init
  settingsConfEl.value = String(overlaySettings.confidenceThreshold);
  settingsTrailEl.value = String(overlaySettings.trailMs / 1000);
  settingsNoteNamesEl.checked = showNoteNames;
  settingsSynthEl.checked = syntheticModeEnabled;
  updateSettingsLabels();
  updatePitchReadout();
  updateSessionRangeReadout();
  updateSessionRangeSummary();
  refreshRecordingControls(ctrl);

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
