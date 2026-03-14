/**
 * pitch-overlay feature
 *
 * Owns:
 *   - WebSocket connection to /ws/pitch
 *   - PitchOverlay (score annotation)
 *   - PitchGraphCanvas (pitch graph panel)
 *   - Settings panel (gear button, all sliders/checkboxes inside it)
 *   - Practice recorder
 *   - Pitch readout (#pitch-readout)
 *
 * Reads:
 *   - Current session from score-session (model, engine for clock)
 *   - selectedPart changes via onScoreLoaded (which re-fires on updateSelectedPart)
 *   - frameXPosition from playback feature
 */
import { onScoreLoaded, onScoreCleared, getSession } from '../../services/score-session';
import { setStatus, showErrorBanner } from '../../services/backend';
import { MIN_CONFIDENCE_THRESHOLD, PitchOverlay, type OverlaySettings } from '../../pitch/overlay';
import { PitchGraphCanvas } from '../../pitch/graph';
import { expectedNoteAtBeat } from '../../pitch/accuracy';
import { syntheticPitchFrameAt } from '../../pitch/synthetic';
import { parsePitchFrame, reconnectDelayMs } from '../../pitch/socket';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { elapsedToBeat } from '../../score/timing';
import { type NoteModel } from '../../score/renderer';
import { resolveSelectedDeviceId, type AudioInputDevice } from '../../audio/devices';
import { PracticeRecorder } from '../../audio/recorder';
import { getFrameXPosition } from '../playback/index';
import { type Feature } from '../../registry';

// ── Module-level singletons (one per app lifetime) ───────────────────────────

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

const overlaySettings: OverlaySettings = {
  confidenceThreshold: MIN_CONFIDENCE_THRESHOLD,
  trailMs: 2000,
};

// ── Pitch readout ────────────────────────────────────────────────────────────

function updatePitchReadout(): void {
  const pitchReadoutEl = document.getElementById('pitch-readout') as HTMLSpanElement;
  if (!lastPitchFrame) { pitchReadoutEl.textContent = 'Detected: —'; return; }
  const hz = midiToFrequency(lastPitchFrame.midi);
  const freqLabel = `${hz.toFixed(2)} Hz`;
  if (!showNoteNames) { pitchReadoutEl.textContent = `Detected: ${freqLabel}`; return; }
  const noteName = midiToNoteName(lastPitchFrame.midi);
  pitchReadoutEl.textContent = `Detected: ${freqLabel} → ${noteName}`;
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

  const expectedMidi = expectedMidiForFrame(frame.t);
  pitchOverlay?.pushFrame(frame, getFrameXPosition(frame.t));
  pitchGraph?.pushFrame(frame, expectedMidi);
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
  if (pitchWs && (pitchWs.readyState === WebSocket.OPEN || pitchWs.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  pitchWs = new WebSocket(`${protocol}://${window.location.host}/ws/pitch`);

  pitchWs.onopen = () => { pitchReconnectAttempts = 0; };
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
    if (!frame) return;
    handleIncomingPitchFrame(frame);
  };
}

// ── Pitch graph RAF loop ─────────────────────────────────────────────────────

function startPitchGraphLoop(): void {
  if (pitchGraphRafId !== null) return;
  const tick = (): void => {
    const session = getSession();
    if (syntheticModeEnabled && session?.engine.playing) {
      const elapsedSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      const elapsedMs = elapsedSec * 1000;
      const expectedMidi = expectedMidiForFrame(elapsedMs);
      handleIncomingPitchFrame(syntheticPitchFrameAt(elapsedSec, expectedMidi));
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

// ── Recording helpers ────────────────────────────────────────────────────────

function setRecordingStatus(msg: string): void {
  const el = document.getElementById('recording-status') as HTMLDivElement;
  el.textContent = msg;
}

function refreshRecordingControls(
  recordingEnabledEl: HTMLInputElement,
  btnRecordStart: HTMLButtonElement,
  btnRecordStop: HTMLButtonElement,
  btnRecordPlay: HTMLButtonElement,
  btnRecordSave: HTMLButtonElement,
  btnRecordDiscard: HTMLButtonElement,
): void {
  const enabled = recordingEnabledEl.checked;
  const isSupported = PracticeRecorder.isSupported();
  const state = practiceRecorder.state;
  btnRecordStart.disabled = !enabled || !isSupported || state === 'recording';
  btnRecordStop.disabled  = !enabled || !isSupported || state !== 'recording';
  btnRecordPlay.disabled  = !enabled || !isSupported || state !== 'recorded';
  btnRecordSave.disabled  = !enabled || !isSupported || state !== 'recorded';
  btnRecordDiscard.disabled = !enabled || !isSupported || state === 'idle';
  if (!enabled) { setRecordingStatus('Recording disabled.'); return; }
  if (!isSupported) { setRecordingStatus('Recording unsupported in this browser.'); return; }
  if (recordingError) { setRecordingStatus(recordingError); return; }
  if (state === 'idle')      setRecordingStatus('Ready to record.');
  if (state === 'recording') setRecordingStatus('Recording…');
  if (state === 'recorded')  setRecordingStatus('Take captured.');
}

// ── Settings panel ──────────────────────────────────────────────────────────

async function refreshAudioSettings(
  settingsDeviceEl: HTMLSelectElement,
  settingsEngineEl: HTMLDivElement,
): Promise<void> {
  try {
    const [devicesRes, engineRes] = await Promise.all([
      fetch('/audio/devices'),
      fetch('/audio/engine'),
    ]);
    if (!devicesRes.ok) throw new Error(`/audio/devices HTTP ${devicesRes.status}`);
    const devicesPayload = (await devicesRes.json()) as {
      default_device_id: number | null;
      devices: AudioInputDevice[];
    };
    settingsDeviceEl.innerHTML = devicesPayload.devices
      .map((d) => `<option value="${d.id}">${d.name}</option>`)
      .join('');
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
  const scoreContainerEl       = document.getElementById('score-container')          as HTMLDivElement;
  const pitchGraphCanvasEl     = document.getElementById('pitch-graph-canvas')       as HTMLDivElement;
  const settingsPanelEl        = document.getElementById('settings-panel')           as HTMLDivElement;
  const btnSettings            = document.getElementById('btn-settings')             as HTMLButtonElement;
  const settingsDeviceEl       = document.getElementById('settings-device')         as HTMLSelectElement;
  const settingsConfidenceEl   = document.getElementById('settings-confidence')     as HTMLInputElement;
  const settingsConfidenceLabelEl = document.getElementById('settings-confidence-label') as HTMLSpanElement;
  const settingsTrailEl        = document.getElementById('settings-trail')          as HTMLInputElement;
  const settingsTrailLabelEl   = document.getElementById('settings-trail-label')    as HTMLSpanElement;
  const settingsShowNoteNamesEl = document.getElementById('settings-show-note-names') as HTMLInputElement;
  const settingsSyntheticModeEl = document.getElementById('settings-synthetic-mode') as HTMLInputElement;
  const settingsEngineEl       = document.getElementById('settings-engine')         as HTMLDivElement;
  const recordingEnabledEl     = document.getElementById('recording-enabled')       as HTMLInputElement;
  const btnRecordStart         = document.getElementById('btn-record-start')        as HTMLButtonElement;
  const btnRecordStop          = document.getElementById('btn-record-stop')         as HTMLButtonElement;
  const btnRecordPlay          = document.getElementById('btn-record-play')         as HTMLButtonElement;
  const btnRecordSave          = document.getElementById('btn-record-save')         as HTMLButtonElement;
  const btnRecordDiscard       = document.getElementById('btn-record-discard')      as HTMLButtonElement;

  function updateSettingsLabels(): void {
    settingsConfidenceLabelEl.textContent = overlaySettings.confidenceThreshold.toFixed(2);
    settingsTrailLabelEl.textContent = `${(overlaySettings.trailMs / 1000).toFixed(1)}s`;
  }

  function rc(): void {
    refreshRecordingControls(recordingEnabledEl,
      btnRecordStart, btnRecordStop, btnRecordPlay, btnRecordSave, btnRecordDiscard);
  }

  // ── Pitch graph ──────────────────────────────────────────────────────────
  pitchGraph = new PitchGraphCanvas(pitchGraphCanvasEl);
  startPitchGraphLoop();

  // ── Session lifecycle ─────────────────────────────────────────────────────
  onScoreCleared(() => {
    closePitchSocket();
    pitchOverlay?.destroy();
    pitchOverlay = null;
    pitchGraph?.clear();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    updatePitchReadout();
  });

  onScoreLoaded((session) => {
    // Re-build overlay for new score / part selection
    pitchOverlay?.destroy();
    pitchOverlay = new PitchOverlay(scoreContainerEl, session.model, session.selectedPart, overlaySettings);
    activePartNotes = session.model.notes.filter((n) => n.part === session.selectedPart);
    pitchGraph?.clear();
    lastPitchFrame = null;
    pitchGraphNowSec = 0;
    updatePitchReadout();
    connectPitchSocket();
  });

  // ── Settings panel ─────────────────────────────────────────────────────
  settingsConfidenceEl.value = String(overlaySettings.confidenceThreshold);
  settingsTrailEl.value = String(overlaySettings.trailMs / 1000);
  settingsShowNoteNamesEl.checked = showNoteNames;
  settingsSyntheticModeEl.checked = syntheticModeEnabled;
  updateSettingsLabels();
  updatePitchReadout();
  rc();

  btnSettings.addEventListener('click', async (event) => {
    event.stopPropagation();
    const visible = settingsPanelEl.classList.toggle('visible');
    if (!visible) return;
    await refreshAudioSettings(settingsDeviceEl, settingsEngineEl);
  });

  settingsPanelEl.addEventListener('click', (event) => { event.stopPropagation(); });

  window.addEventListener('click', (event) => {
    if (!settingsPanelEl.classList.contains('visible')) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (settingsPanelEl.contains(target) || btnSettings.contains(target)) return;
    settingsPanelEl.classList.remove('visible');
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') settingsPanelEl.classList.remove('visible');
  });

  settingsDeviceEl.addEventListener('change', () => {
    const value = settingsDeviceEl.value;
    if (value === '') { selectedDeviceId = null; return; }
    const parsed = Number.parseInt(value, 10);
    selectedDeviceId = Number.isNaN(parsed) ? null : parsed;
  });

  settingsConfidenceEl.addEventListener('input', () => {
    overlaySettings.confidenceThreshold = parseFloat(settingsConfidenceEl.value);
    pitchOverlay?.applySettings(overlaySettings);
    updateSettingsLabels();
  });

  settingsTrailEl.addEventListener('input', () => {
    overlaySettings.trailMs = parseFloat(settingsTrailEl.value) * 1000;
    pitchOverlay?.applySettings(overlaySettings);
    updateSettingsLabels();
  });

  settingsShowNoteNamesEl.addEventListener('change', () => {
    showNoteNames = settingsShowNoteNamesEl.checked;
    updatePitchReadout();
  });

  settingsSyntheticModeEl.addEventListener('change', () => {
    syntheticModeEnabled = settingsSyntheticModeEl.checked;
    closePitchSocket();
    if (!syntheticModeEnabled) connectPitchSocket();
  });

  // ── Recording ───────────────────────────────────────────────────────────
  recordingEnabledEl.addEventListener('change', () => {
    if (!recordingEnabledEl.checked) practiceRecorder.discard();
    recordingError = null;
    rc();
  });

  btnRecordStart.addEventListener('click', async () => {
    try {
      await practiceRecorder.start();
      recordingError = null;
      rc();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordingError = message.toLowerCase().includes('denied') || message.toLowerCase().includes('notallowed')
        ? 'Microphone permission denied. Recording remains off until access is granted.'
        : `Could not start recording: ${message}`;
      rc();
    }
  });

  btnRecordStop.addEventListener('click', async () => {
    await practiceRecorder.stop();
    recordingError = null;
    rc();
  });

  btnRecordPlay.addEventListener('click', () => {
    const audio = practiceRecorder.playLastTake();
    if (!audio) setRecordingStatus('No take to play yet.');
  });

  btnRecordSave.addEventListener('click', async () => {
    try {
      const saved = await practiceRecorder.saveLastTake();
      if (!saved) setRecordingStatus('No take to save yet.');
      else setRecordingStatus('Take saved.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) { setRecordingStatus('Save cancelled.'); return; }
      setRecordingStatus(`Could not save take: ${message}`);
    }
  });

  btnRecordDiscard.addEventListener('click', () => {
    practiceRecorder.discard();
    recordingError = null;
    rc();
  });

  // ── Cleanup on page unload ─────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    closePitchSocket();
    stopPitchGraphLoop();
    pitchOverlay?.destroy();
    pitchGraph?.destroy();
    practiceRecorder.destroy();
  });
}

function unmount(): void {
  closePitchSocket();
  stopPitchGraphLoop();
  pitchOverlay?.destroy();
  pitchOverlay = null;
  pitchGraph?.destroy();
  pitchGraph = null;
  practiceRecorder.destroy();
}

export const pitchOverlayFeature: Feature = {
  id: 'slot-pitch-overlay',
  mount,
  unmount,
};
