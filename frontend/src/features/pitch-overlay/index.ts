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
import { onScoreLoaded, onScoreCleared, onPartChanged, getSession } from '../../services/score-session';
import { onPlaybackSyncEvent } from '../../services/playback-sync';
import { showErrorBanner } from '../../services/backend';
import { getFrameXPosition } from '../../services/cursor-projection';
import { DEFAULT_CONFIDENCE_THRESHOLD, PitchOverlay, type OverlaySettings } from '../../pitch/overlay';
import { PitchGraphCanvas } from '../../pitch/graph';
import { expectedNoteAtBeat } from '../../pitch/accuracy';
import { syntheticPitchFrameAt } from '../../pitch/synthetic';
import { PitchTimelineSync } from '../../pitch/timeline-sync';
import { parsePitchSocketMessage, reconnectDelayMs, type PitchFrame } from '../../pitch/socket';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { SessionRangeTracker } from '../../pitch/session-range';
import {
  DEFAULT_STABLE_NOTE_SETTINGS,
  StableNoteDetector,
  type StableNoteSettings,
} from '../../pitch/stable-note';
import { StablePitchTracker } from '../../pitch/diagnostics';
import { elapsedToBeat } from '../../score/timing';
import { type NoteModel } from '../../score/renderer';
import { PhraseSummaryTracker, type PhraseSummary } from '../../pitch/phrase-summary';
import { resolveSelectedDeviceId, type AudioInputDevice } from '../../audio/devices';
import { PracticeRecorder } from '../../audio/recorder';
import { sessionSummaryTracker } from '../../practice/session-summary';
import { capturePitchFrame } from '../../services/progress-history';
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
let lastPitchFrame: PitchFrame | null = null;
let activePartNotes: NoteModel[] = [];
let showNoteNames = false;
let syntheticModeEnabled = false;
let selectedDeviceId: number | null = null;
let recordingError: string | null = null;
let lastStableMidi: number | null = null;
let sessionRangeSummaryText = 'Last session range: —';
let wasPlayingLastTick = false;
let phraseSummaryTracker: PhraseSummaryTracker | null = null;
let diagnosticsModeEnabled = false;
const stablePitchTracker = new StablePitchTracker();
const sessionRangeTracker = new SessionRangeTracker();
const timelineSync = new PitchTimelineSync();
let playbackSyncUnsubscribe: (() => void) | null = null;
let syncOffsetWarningShown = false;

const overlaySettings: OverlaySettings = {
  confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  trailMs: 2000,
};

const stableNoteSettings: StableNoteSettings = { ...DEFAULT_STABLE_NOTE_SETTINGS };
const stableNoteDetector = new StableNoteDetector(stableNoteSettings);

// ── Pitch readout ────────────────────────────────────────────────────────────

function updatePitchReadout(): void {
  const el = document.getElementById('pitch-readout') as HTMLSpanElement;
  if (!lastPitchFrame) { el.textContent = 'Detected: —'; return; }
  const rawHz = midiToFrequency(lastPitchFrame.midi);
  const rawLabel = `${rawHz.toFixed(2)} Hz`;
  const stableLabel = lastStableMidi === null
    ? '—'
    : `${midiToFrequency(lastStableMidi).toFixed(2)} Hz`;
  if (!showNoteNames) {
    el.textContent = `Raw: ${rawLabel} · Stable: ${stableLabel}`;
    return;
  }
  const rawNoteLabel = midiToNoteName(lastPitchFrame.midi);
  const stableNoteLabel = lastStableMidi === null ? '—' : midiToNoteName(lastStableMidi);
  el.textContent = `Raw: ${rawLabel} (${rawNoteLabel}) · Stable: ${stableLabel} (${stableNoteLabel})`;
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
  const session = getSession();
  if (session) {
    const staleWindowMs = Math.max(2000, overlaySettings.trailMs * 1.5);
    if (timelineSync.isFrameStale(frame.t, session.engine.ctx.currentTime, staleWindowMs)) {
      return;
    }
  }

  // Update state only after the stale-frame guard: late/post-seek frames must
  // not corrupt the stability window or the readout.
  const stableState = stableNoteDetector.pushFrame(frame);
  lastPitchFrame = frame;
  lastStableMidi = stableState.stableMidi;

  updatePitchReadout();
  const frameSec = frame.t / 1000;
  if (Number.isFinite(frameSec) && frameSec >= 0) {
    pitchGraphNowSec = Math.max(pitchGraphNowSec, frameSec);
  }
  // Overlay dots use the stabilised midi for visual smoothness; the accuracy
  // graph always receives the raw frame so it reflects what the singer actually
  // sang rather than the smoothed estimate.
  const overlayMidi = stableState.stableMidi ?? frame.midi;
  const displayFrame = { ...frame, midi: overlayMidi };
  pitchOverlay?.pushFrame(displayFrame, getFrameXPosition(frame.t));
  pitchGraph?.pushFrame(frame, expectedMidiForFrame(frame.t));
  if (sessionRangeTracker.ingest(frame, overlaySettings.confidenceThreshold)) {
    updateSessionRangeReadout();
  }
  sessionSummaryTracker.recordFrame(frame);
  window.dispatchEvent(new CustomEvent('stable-pitch-frame', {
    detail: {
      t: frame.t,
      rawMidi: stableState.rawMidi,
      stableMidi: stableState.stableMidi,
      conf: frame.conf,
    },
  }));
  capturePitchFrame(frame);
  const completedPhrases = phraseSummaryTracker?.pushFrame(frame) ?? [];
  for (const summary of completedPhrases) {
    renderPhraseSummary(summary);
  }
  updateDiagnostics(frame);
}

function shouldStreamPitch(): boolean {
  return syntheticModeEnabled || diagnosticsModeEnabled || pitchOverlay !== null;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function renderMiniKeyboard(activeMidi: number | null): void {
  const keyboardEl = document.getElementById('diag-keyboard') as HTMLDivElement;
  if (keyboardEl.childElementCount === 0) {
    const startMidi = 48;
    for (let i = 0; i < 24; i += 1) {
      const midi = startMidi + i;
      const keyEl = document.createElement('div');
      keyEl.className = 'diag-key';
      if ([1, 3, 6, 8, 10].includes(midi % 12)) keyEl.classList.add('black');
      keyEl.dataset.midi = String(midi);
      keyboardEl.appendChild(keyEl);
    }
  }
  for (const child of Array.from(keyboardEl.children)) {
    if (!(child instanceof HTMLDivElement)) continue;
    child.classList.toggle('active', activeMidi !== null && Number(child.dataset.midi) === activeMidi);
  }
}

function clearDiagnostics(): void {
  (document.getElementById('diag-note') as HTMLDivElement).textContent = '—';
  (document.getElementById('diag-cents') as HTMLDivElement).textContent = '—';
  const stabilityEl = document.getElementById('diag-stability') as HTMLDivElement;
  stabilityEl.textContent = 'No signal';
  stabilityEl.classList.remove('unstable');
  (document.getElementById('diag-held') as HTMLDivElement).textContent = '0.0s';
  (document.getElementById('diag-confidence') as HTMLDivElement).textContent = '0.00';
  (document.getElementById('diag-confidence-fill') as HTMLDivElement).style.width = '0%';
  stablePitchTracker.reset();
  renderMiniKeyboard(null);
}

function updateDiagnostics(frame: { t: number; midi: number; conf: number }): void {
  if (!diagnosticsModeEnabled) return;
  const noteEl = document.getElementById('diag-note') as HTMLDivElement;
  const centsEl = document.getElementById('diag-cents') as HTMLDivElement;
  const stabilityEl = document.getElementById('diag-stability') as HTMLDivElement;
  const heldEl = document.getElementById('diag-held') as HTMLDivElement;
  const confEl = document.getElementById('diag-confidence') as HTMLDivElement;
  const confFillEl = document.getElementById('diag-confidence-fill') as HTMLDivElement;

  const state = stablePitchTracker.push(frame, overlaySettings.confidenceThreshold);
  noteEl.textContent = state.noteName;
  centsEl.textContent = `${state.cents >= 0 ? '+' : ''}${state.cents.toFixed(1)} cents`;
  stabilityEl.textContent = state.stable ? 'Stable' : 'Unstable';
  stabilityEl.classList.toggle('unstable', !state.stable);
  heldEl.textContent = `${(state.heldMs / 1000).toFixed(1)}s`;
  confEl.textContent = frame.conf.toFixed(2);
  confFillEl.style.width = `${Math.max(0, Math.min(100, frame.conf * 100))}%`;
  renderMiniKeyboard(state.activeMidi);
}

// ── Phrase summary ───────────────────────────────────────────────────────────


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
  if (!shouldStreamPitch() || syntheticModeEnabled) return;
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
    if (!shouldReconnectPitchSocket || !shouldStreamPitch()) return;
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
    if (syntheticModeEnabled && session?.engine.playing) {
      const elapsedSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      handleIncomingPitchFrame(syntheticPitchFrameAt(elapsedSec, expectedMidiForFrame(elapsedSec * 1000)));
    }
    if (session?.engine.playing) {
      const playbackSec = Math.max(0, session.engine.ctx.currentTime - session.engine.startAudioTime);
      pitchGraphNowSec = Math.max(pitchGraphNowSec, playbackSec);
    }
    const isPlaying = !!session?.engine.playing;
    if (wasPlayingLastTick && !isPlaying) {
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
  const diagnosticsPanelEl  = document.getElementById('pitch-diagnostics-panel')    as HTMLElement;
  const diagnosticsToggleEl = document.getElementById('btn-diagnostics')            as HTMLButtonElement;
  const btnSettings         = document.getElementById('btn-settings')              as HTMLButtonElement;
  const settingsDeviceEl    = document.getElementById('settings-device')          as HTMLSelectElement;
  const settingsConfEl      = document.getElementById('settings-confidence')      as HTMLInputElement;
  const settingsConfLabelEl = document.getElementById('settings-confidence-label') as HTMLSpanElement;
  const settingsTrailEl     = document.getElementById('settings-trail')            as HTMLInputElement;
  const settingsTrailLabelEl = document.getElementById('settings-trail-label')    as HTMLSpanElement;
  const settingsNoteNamesEl = document.getElementById('settings-show-note-names') as HTMLInputElement;
  const settingsSynthEl     = document.getElementById('settings-synthetic-mode')  as HTMLInputElement;
  const settingsEngineEl    = document.getElementById('settings-engine')           as HTMLDivElement;
  const stableConfEl        = document.getElementById('settings-stable-confidence') as HTMLInputElement;
  const stableConfLabelEl   = document.getElementById('settings-stable-confidence-label') as HTMLSpanElement;
  const stableClusterEl     = document.getElementById('settings-stable-cluster') as HTMLInputElement;
  const stableClusterLabelEl = document.getElementById('settings-stable-cluster-label') as HTMLSpanElement;
  const stableHoldEl        = document.getElementById('settings-stable-hold') as HTMLInputElement;
  const stableHoldLabelEl   = document.getElementById('settings-stable-hold-label') as HTMLSpanElement;
  const stableWindowEl      = document.getElementById('settings-stable-window') as HTMLInputElement;
  const stableWindowLabelEl = document.getElementById('settings-stable-window-label') as HTMLSpanElement;
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
    stableConfLabelEl.textContent = stableNoteSettings.minConfidence.toFixed(2);
    stableClusterLabelEl.textContent = `${Math.round(stableNoteSettings.clusteringToleranceCents)} cents`;
    stableHoldLabelEl.textContent = `${Math.round(stableNoteSettings.holdDurationMs)} ms`;
    stableWindowLabelEl.textContent = `${Math.round(stableNoteSettings.smoothingWindowMs)} ms`;
  }

  function applyStableSettings(): void {
    stableNoteDetector.applySettings(stableNoteSettings);
  }

  pitchGraph = new PitchGraphCanvas(pitchGraphCanvasEl);
  bindPlaybackSync();
  startPitchGraphLoop();
  clearDiagnostics();
  clearPhraseSummaryPanel();

  onScoreCleared(() => {
    finalizeSessionRangeSummary();
    if (!diagnosticsModeEnabled) closePitchSocket();
    pitchOverlay?.destroy();
    pitchOverlay = null;
    pitchGraph?.clear();
    timelineSync.reset();
    lastPitchFrame = null;
    lastStableMidi = null;
    stableNoteDetector.reset();
    pitchGraphNowSec = 0;
    wasPlayingLastTick = false;
    sessionRangeTracker.reset();
    sessionSummaryTracker.reset();
    phraseSummaryTracker = null;
    clearPhraseSummaryPanel();
    updatePitchReadout();
    updateSessionRangeReadout();
    clearDiagnostics();
    if (diagnosticsModeEnabled) connectPitchSocket();
  });

  onScoreLoaded((session) => {
    pitchOverlay?.destroy();
    pitchOverlay = new PitchOverlay(
      scoreContainerEl, session.model, session.selectedPart, overlaySettings);
    activePartNotes = session.model.notes.filter((n) => n.part === session.selectedPart);
    sessionSummaryTracker.setContext(session.model.tempo_marks, activePartNotes);
    phraseSummaryTracker = new PhraseSummaryTracker(activePartNotes, session.model.tempo_marks);
    pitchGraph?.clear();
    timelineSync.reset();
    lastPitchFrame = null;
    lastStableMidi = null;
    stableNoteDetector.reset();
    pitchGraphNowSec = 0;
    wasPlayingLastTick = false;
    sessionRangeTracker.reset();
    clearPhraseSummaryPanel();
    updatePitchReadout();
    updateSessionRangeReadout();
    clearDiagnostics();
    connectPitchSocket();
  });

  onPartChanged((session) => {
    if (!pitchOverlay) return;
    pitchOverlay.destroy();
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
  });

  btnStop.addEventListener('click', () => {
    phraseSummaryTracker?.reset();
    clearPhraseSummaryPanel();
  });
  btnRewind.addEventListener('click', () => {
    phraseSummaryTracker?.reset();
    clearPhraseSummaryPanel();
  });

  diagnosticsToggleEl.addEventListener('click', () => {
    diagnosticsModeEnabled = !diagnosticsModeEnabled;
    diagnosticsPanelEl.classList.toggle('visible', diagnosticsModeEnabled);
    diagnosticsToggleEl.classList.toggle('active', diagnosticsModeEnabled);
    if (diagnosticsModeEnabled) {
      connectPitchSocket();
    } else if (!pitchOverlay) {
      closePitchSocket();
      clearDiagnostics();
    }
  });

  // Settings panel init
  settingsConfEl.value = String(overlaySettings.confidenceThreshold);
  settingsTrailEl.value = String(overlaySettings.trailMs / 1000);
  stableConfEl.value = String(stableNoteSettings.minConfidence);
  stableClusterEl.value = String(stableNoteSettings.clusteringToleranceCents);
  stableHoldEl.value = String(stableNoteSettings.holdDurationMs);
  stableWindowEl.value = String(stableNoteSettings.smoothingWindowMs);
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
  stableConfEl.addEventListener('input', () => {
    stableNoteSettings.minConfidence = parseFloat(stableConfEl.value);
    applyStableSettings();
    updateSettingsLabels();
  });
  stableClusterEl.addEventListener('input', () => {
    stableNoteSettings.clusteringToleranceCents = parseFloat(stableClusterEl.value);
    applyStableSettings();
    updateSettingsLabels();
  });
  stableHoldEl.addEventListener('input', () => {
    stableNoteSettings.holdDurationMs = parseFloat(stableHoldEl.value);
    applyStableSettings();
    updateSettingsLabels();
  });
  stableWindowEl.addEventListener('input', () => {
    stableNoteSettings.smoothingWindowMs = parseFloat(stableWindowEl.value);
    applyStableSettings();
    updateSettingsLabels();
  });
  settingsNoteNamesEl.addEventListener('change', () => {
    showNoteNames = settingsNoteNamesEl.checked;
    updatePitchReadout();
  });
  settingsSynthEl.addEventListener('change', () => {
    syntheticModeEnabled = settingsSynthEl.checked;
    closePitchSocket();
    if (!syntheticModeEnabled && shouldStreamPitch()) connectPitchSocket();
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
