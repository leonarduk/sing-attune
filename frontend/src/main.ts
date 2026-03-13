/**
 * sing-attune frontend entry point.
 *
 * Day 8b: replaces Day 8a's wall-clock cursor loop with an AudioContext-driven
 * approach. PlaybackEngine pre-schedules all notes; ScoreCursor is driven
 * externally via engine.currentBeat in a RAF loop.
 *
 * Clock hierarchy (must never be broken):
 *   AudioContext.currentTime → engine.currentBeat → cursor.seekToBeat()
 *
 * Day 9 handover:
 *   pitch overlay reads engine.ctx.currentTime − engine.startAudioTime to
 *   compute elapsed seconds → beat → cursor position. No engine changes needed.
 */
import { ScoreRenderer } from './score/renderer';
import { ScoreCursor } from './score/cursor';
import { SoundfontLoader } from './playback/soundfont';
import { PlaybackEngine } from './playback/engine';
import { PitchOverlay, type OverlaySettings } from './pitch/overlay';
import { parsePitchFrame, reconnectDelayMs } from './pitch/socket';
import { getVisiblePartOptions } from './part-options';
import { beatToMs, startPlayback, postPlayback, seekPlayback, setPlaybackTempo, setPlaybackTranspose } from './transport/controls';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const statusEl        = document.getElementById('status')       as HTMLSpanElement;
const dropZoneEl      = document.getElementById('drop-zone')    as HTMLDivElement;
const fileInputEl     = document.getElementById('file-input')   as HTMLInputElement;
const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement;
const scoreInfoEl     = document.getElementById('score-info')   as HTMLDivElement;
const btnPlay         = document.getElementById('btn-play')     as HTMLButtonElement;
const btnPause        = document.getElementById('btn-pause')    as HTMLButtonElement;
const btnStop         = document.getElementById('btn-stop')     as HTMLButtonElement;
const btnRewind       = document.getElementById('btn-rewind')   as HTMLButtonElement;
const partSelectEl    = document.getElementById('part-select')  as HTMLSelectElement;
const tempoSliderEl   = document.getElementById('tempo-slider') as HTMLInputElement;
const tempoLabelEl    = document.getElementById('tempo-label')  as HTMLSpanElement;
const btnBrowse       = document.getElementById('btn-browse')    as HTMLButtonElement;
const headphoneWarning = document.getElementById('headphone-warning') as HTMLDivElement;
const warningDismiss  = document.getElementById('warning-dismiss') as HTMLButtonElement;
const scoreLoadingEl  = document.getElementById('score-loading') as HTMLDivElement;
const errorBannerEl   = document.getElementById('error-banner') as HTMLDivElement;
const showAccompanimentEl = document.getElementById('show-accompaniment') as HTMLInputElement;
const transposeSelectEl = document.getElementById('transpose-select') as HTMLSelectElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const settingsPanelEl = document.getElementById('settings-panel') as HTMLDivElement;
const settingsDeviceEl = document.getElementById('settings-device') as HTMLSelectElement;
const settingsConfidenceEl = document.getElementById('settings-confidence') as HTMLInputElement;
const settingsConfidenceLabelEl = document.getElementById('settings-confidence-label') as HTMLSpanElement;
const settingsTrailEl = document.getElementById('settings-trail') as HTMLInputElement;
const settingsTrailLabelEl = document.getElementById('settings-trail-label') as HTMLSpanElement;
const settingsEngineEl = document.getElementById('settings-engine') as HTMLDivElement;

// ── Module state ──────────────────────────────────────────────────────────────

let renderer: ScoreRenderer | null = null;
let cursor: ScoreCursor | null = null;
let engine: PlaybackEngine | null = null;

// Singletons — created once per session
let audioCtx: AudioContext | null = null;
let soundfont: SoundfontLoader | null = null;
let soundfontLoadPromise: Promise<void> | null = null;

// External cursor RAF (replaces ScoreCursor's internal wall-clock loop)
let cursorRafId: number | null = null;
let pitchOverlay: PitchOverlay | null = null;
let pitchWs: WebSocket | null = null;
let pitchReconnectTimer: number | null = null;
let shouldReconnectPitchSocket = false;
let pitchReconnectAttempts = 0;

const overlaySettings: OverlaySettings = {
  confidenceThreshold: 0.6,
  trailMs: 2000,
};
let selectedDeviceId: number | null = null;

// ── Backend health ────────────────────────────────────────────────────────────

async function checkBackend(): Promise<void> {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version: string };
    clearErrorBanner();
    setStatus(`backend ok (v${data.version})`, 'ok');
  } catch (err) {
    showErrorBanner('Cannot reach backend. Start backend and refresh the page.');
    setStatus('backend unreachable', 'error');
    console.error('Backend health check failed:', err);
  }
}

function setStatus(msg: string, cls: 'ok' | 'error' | 'loading' | ''): void {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

function showLoading(message: string): void {
  scoreLoadingEl.textContent = message;
  scoreLoadingEl.classList.add('visible');
}

function hideLoading(): void {
  scoreLoadingEl.classList.remove('visible');
}

function showErrorBanner(message: string): void {
  errorBannerEl.textContent = message;
  errorBannerEl.classList.add('visible');
}

function clearErrorBanner(): void {
  errorBannerEl.textContent = '';
  errorBannerEl.classList.remove('visible');
}

// ── Soundfont ─────────────────────────────────────────────────────────────────

/**
 * Create AudioContext + start loading soundfont samples in the background.
 * Called on first score load. Idempotent.
 */
function ensureSoundfont(): void {
  if (soundfontLoadPromise) return;
  // Electron does not enforce the user-gesture requirement for AudioContext.
  // For browser fallback, the AudioContext may start 'suspended'; we resume
  // it in engine.play() via ctx.resume().
  audioCtx = new AudioContext();
  soundfont = new SoundfontLoader();
  soundfontLoadPromise = soundfont.load(audioCtx).catch((err: unknown) => {
    console.error('[Soundfont] load failed:', err);
    showErrorBanner('Soundfont failed to load; playback is unavailable.');
    setStatus('soundfont load failed — no audio', 'error');
  });
}

// ── Score loading ─────────────────────────────────────────────────────────────

async function loadScore(file: File): Promise<void> {
  clearErrorBanner();
  showLoading(`Loading ${file.name}…`);
  setStatus(`Loading ${file.name}…`, 'loading');
  dropZoneEl.classList.add('hidden');
  scoreInfoEl.textContent = '';
  setTransportEnabled(false);
  headphoneWarning.classList.add('hidden');

  // Tear down previous state
  stopCursorRaf();
  engine?.stop();
  cursor?.stop();
  engine = null;
  cursor = null;
  closePitchSocket();
  pitchOverlay?.destroy();
  pitchOverlay = null;
  scoreContainerEl.innerHTML = '';

  // Start soundfont loading in background (idempotent)
  ensureSoundfont();

  renderer = new ScoreRenderer(scoreContainerEl);
  try {
    const model = await renderer.load(file);

    // Populate part selector (accompaniment hidden by default)
    const visibleParts = getVisiblePartOptions(model.parts, showAccompanimentEl.checked);
    partSelectEl.innerHTML = visibleParts
      .map((option) => `<option value="${option.name}">${option.name}</option>`)
      .join('');
    const selectedPart = visibleParts[0]?.name ?? model.parts[0] ?? '';
    partSelectEl.value = selectedPart;
    partSelectEl.disabled = visibleParts.length <= 1;

    const bpm = model.tempo_marks[0]?.bpm ?? 120;
    scoreInfoEl.textContent =
      `${model.title} — ${model.parts.join(', ')} — ${bpm} bpm — ${model.total_beats.toFixed(0)} beats`;

    // Wait for soundfont before constructing engine
    await soundfontLoadPromise;
    if (!audioCtx || !soundfont) throw new Error('AudioContext not available');

    engine = new PlaybackEngine(audioCtx, soundfont);
    engine.setTransposeSemitones(getTransposeSemitones());
    engine.schedule(
      model.notes,
      model.tempo_marks,
      selectedPart,
      parseFloat(tempoSliderEl.value) / 100,
    );

    cursor = new ScoreCursor(renderer.osmd, model);
    renderer.setHighlightedPart(selectedPart);
    pitchOverlay = new PitchOverlay(scoreContainerEl, model, selectedPart, overlaySettings);
    connectPitchSocket();
    setTransportEnabled(true);
    setStatus('score loaded', 'ok');
  } catch (err) {
    showErrorBanner('Could not load this MusicXML file. Try exporting again from notation software.');
    setStatus(String(err), 'error');
    console.error('Score load failed:', err);
    dropZoneEl.classList.remove('hidden');
  } finally {
    hideLoading();
  }
}

// ── External cursor clock ─────────────────────────────────────────────────────

/**
 * Drive ScoreCursor from engine.currentBeat instead of its internal wall clock.
 * This ensures the cursor position is derived from AudioContext.currentTime —
 * the same clock the audio engine uses — eliminating drift between audio and
 * visual position.
 */
function startCursorRaf(): void {
  stopCursorRaf();
  function tick(): void {
    if (engine?.playing && cursor) {
      cursor.seekToBeat(engine.currentBeat);
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
}

/**
 * Seek forward or backward by one bar.
 *
 * Step size is derived from the score's first time signature numerator so the
 * jump is always a whole bar (e.g. 3 beats in 3/4, 4 in 4/4). Falls back to
 * 4 if the score has no time signature data.
 *
 * Backend seek is awaited before moving the frontend to avoid a race where
 * the frontend has moved but the backend still emits frames from the old position.
 */
async function seekByBeats(delta: number): Promise<void> {
  if (!engine || !cursor || !renderer?.scoreModel) return;
  const totalBeats = renderer.scoreModel.total_beats;
  const stepBeats = renderer.scoreModel.time_signatures[0]?.numerator ?? 4;
  const targetBeat = Math.max(0, Math.min(totalBeats, engine.currentBeat + delta * stepBeats));
  try {
    await seekPlayback(beatToMs(targetBeat, renderer.scoreModel, engine.tempoMultiplier));
  } catch (err) {
    setStatus(`seek failed: ${String(err)}`, 'error');
    console.error('Seek failed:', err);
    return;
  }

  engine.seekToBeat(targetBeat);
  cursor.seekToBeat(targetBeat);
  if (engine.state !== 'playing') stopCursorRaf();
}

/** Read the current transpose selector value as an integer, defaulting to 0. */
function getTransposeSemitones(): number {
  const parsed = parseInt(transposeSelectEl.value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function cursorXPosition(): number {
  const cursorEl = cursor?.osmd.cursor.cursorElement;
  if (!cursorEl) return 0;

  const scoreRect = scoreContainerEl.getBoundingClientRect();
  const cursorRect = cursorEl.getBoundingClientRect();
  return cursorRect.left - scoreRect.left + scoreContainerEl.scrollLeft;
}

function closePitchSocket(): void {
  shouldReconnectPitchSocket = false;
  pitchReconnectAttempts = 0;
  if (pitchReconnectTimer !== null) {
    window.clearTimeout(pitchReconnectTimer);
    pitchReconnectTimer = null;
  }

  if (pitchWs) {
    pitchWs.close();
    pitchWs = null;
  }
}

function connectPitchSocket(): void {
  if (!pitchOverlay) return;
  shouldReconnectPitchSocket = true;

  if (pitchReconnectTimer !== null) {
    window.clearTimeout(pitchReconnectTimer);
    pitchReconnectTimer = null;
  }

  if (pitchWs && (pitchWs.readyState === WebSocket.OPEN || pitchWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  pitchWs = new WebSocket(`${protocol}://${window.location.host}/ws/pitch`);

  pitchWs.onopen = () => {
    pitchReconnectAttempts = 0;
  };

  pitchWs.onerror = () => {
    pitchWs?.close();
  };

  pitchWs.onclose = () => {
    pitchWs = null;
    if (!shouldReconnectPitchSocket || !pitchOverlay) return;

    pitchReconnectAttempts += 1;
    const delayMs = reconnectDelayMs(pitchReconnectAttempts);

    pitchReconnectTimer = window.setTimeout(() => {
      pitchReconnectTimer = null;
      connectPitchSocket();
    }, delayMs);
  };

  pitchWs.onmessage = (event) => {
    if (!pitchOverlay) return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }

    const frame = parsePitchFrame(payload);
    if (!frame) return;

    pitchOverlay.pushFrame(
      frame,
      cursorXPosition(),
    );
  };
}

function scheduleSelectedPart(selectedPart: string): void {
  if (!engine || !renderer?.scoreModel || !selectedPart) return;
  const partExistsInModel = renderer.scoreModel.parts.includes(selectedPart);
  const partExistsInNotes = renderer.scoreModel.notes.some((note) => note.part === selectedPart);
  if (!partExistsInModel || !partExistsInNotes) return;

  if (engine.state === 'playing') {
    // Live switches are handled by the engine's own stop/reschedule flow.
    engine.selectPart(selectedPart);
  } else {
    const semitones = Number(transposeSelectEl.value);
    const clampedSemitones = Number.isInteger(semitones) ? Math.max(-24, Math.min(24, semitones)) : 0;
    engine.schedule(
      renderer.scoreModel.notes,
      renderer.scoreModel.tempo_marks,
      selectedPart,
      parseFloat(tempoSliderEl.value) / 100,
    );
    engine.setTransposeSemitones(clampedSemitones);
  }

  renderer.setHighlightedPart(selectedPart);
}



function updateSettingsLabels(): void {
  settingsConfidenceLabelEl.textContent = overlaySettings.confidenceThreshold.toFixed(2);
  settingsTrailLabelEl.textContent = `${(overlaySettings.trailMs / 1000).toFixed(1)}s`;
}

async function refreshAudioSettings(): Promise<void> {
  try {
    const [devicesRes, engineRes] = await Promise.all([
      fetch('/audio/devices'),
      fetch('/audio/engine'),
    ]);

    if (!devicesRes.ok) throw new Error(`/audio/devices HTTP ${devicesRes.status}`);
    const devicesPayload = (await devicesRes.json()) as {
      default_device_id: number | null;
      devices: Array<{ id: number; name: string }>;
    };

    settingsDeviceEl.innerHTML = devicesPayload.devices
      .map((device) => `<option value="${device.id}">${device.name}</option>`)
      .join('');

    if (selectedDeviceId === null) selectedDeviceId = devicesPayload.default_device_id;
    if (selectedDeviceId !== null) settingsDeviceEl.value = String(selectedDeviceId);

    if (engineRes.ok) {
      const enginePayload = (await engineRes.json()) as { active_engine: string; mode: string };
      settingsEngineEl.textContent = `Pitch engine: ${enginePayload.active_engine} (${enginePayload.mode})`;
    } else {
      settingsEngineEl.textContent = 'Pitch engine: unavailable';
    }
  } catch (err) {
    settingsEngineEl.textContent = 'Pitch engine: unavailable';
    console.error('Failed to load settings data:', err);
  }
}

function refreshPartSelector(): void {
  if (!renderer?.scoreModel) return;
  const allParts = renderer.scoreModel.parts;
  const selectedBefore = partSelectEl.value;
  const visibleParts = getVisiblePartOptions(allParts, showAccompanimentEl.checked);
  partSelectEl.innerHTML = visibleParts
    .map((option) => `<option value="${option.name}">${option.name}</option>`)
    .join('');

  const stillVisible = visibleParts.some((option) => option.name === selectedBefore);
  const selectedPart = stillVisible ? selectedBefore : (visibleParts[0]?.name ?? allParts[0] ?? '');
  partSelectEl.value = selectedPart;
  partSelectEl.disabled = !engine || visibleParts.length <= 1;
  scheduleSelectedPart(selectedPart);
}

// ── Transport controls ────────────────────────────────────────────────────────

btnPlay.addEventListener('click', async () => {
  if (!engine || !cursor || !renderer?.scoreModel) return;
  if (engine.state === 'playing') return;

  // Show headphone warning on every play
  headphoneWarning.classList.remove('hidden');

  const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;

  try {
    if (fromBeat > 0) {
      await postPlayback('/playback/resume');
    } else {
      await startPlayback(selectedDeviceId);
      cursor.stop();
      cursor.osmd.cursor.show();
      pitchOverlay?.clear();
    }

    engine.play(fromBeat);
    startCursorRaf();
  } catch (err) {
    setStatus(`playback start failed: ${String(err)}`, 'error');
    console.error('Play failed:', err);
  }
});

btnPause.addEventListener('click', async () => {
  if (!engine) return;
  try {
    await postPlayback('/playback/pause');
    engine.pause();
    stopCursorRaf();
  } catch (err) {
    setStatus(`pause failed: ${String(err)}`, 'error');
    console.error('Pause failed:', err);
  }
});

btnStop.addEventListener('click', async () => {
  if (!engine || !cursor) return;
  try {
    await postPlayback('/playback/stop');
    engine.stop();
    stopCursorRaf();
    cursor.stop();
    pitchOverlay?.clear();
    headphoneWarning.classList.add('hidden');
  } catch (err) {
    setStatus(`stop failed: ${String(err)}`, 'error');
    console.error('Stop failed:', err);
  }
});

btnRewind.addEventListener('click', async () => {
  if (!engine || !cursor) return;
  try {
    await postPlayback('/playback/stop');
  } catch (err) {
    setStatus(`rewind failed: ${String(err)}`, 'error');
    console.error('Rewind failed:', err);
  }
  engine.stop();
  stopCursorRaf();
  cursor.stop();
  cursor.osmd.cursor.show();
  headphoneWarning.classList.add('hidden');
});

// ── Part selector ─────────────────────────────────────────────────────────────

partSelectEl.addEventListener('change', () => {
  if (!engine || !renderer?.scoreModel) return;
  pitchOverlay?.updatePart(partSelectEl.value);
  scheduleSelectedPart(partSelectEl.value);
});

showAccompanimentEl.addEventListener('change', () => {
  refreshPartSelector();
});

// ── Tempo slider ──────────────────────────────────────────────────────────────

tempoSliderEl.addEventListener('input', () => {
  tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
});

tempoSliderEl.addEventListener('change', async () => {
  if (!engine) return;

  const previousMultiplier = engine.tempoMultiplier;
  const nextMultiplier = parseFloat(tempoSliderEl.value) / 100;

  engine.setTempoMultiplier(nextMultiplier);

  try {
    await setPlaybackTempo(nextMultiplier);
  } catch (err) {
    engine.setTempoMultiplier(previousMultiplier);
    tempoSliderEl.value = String(Math.round(previousMultiplier * 100));
    tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
    setStatus(`tempo update failed: ${String(err)}`, 'error');
    console.error('Tempo update failed:', err);
  }
});

// ── Transpose selector ───────────────────────────────────────────────────────

transposeSelectEl.addEventListener('change', async () => {
  const semitones = getTransposeSemitones();
  engine?.setTransposeSemitones(semitones);
  try {
    await setPlaybackTranspose(semitones);
  } catch (err) {
    setStatus(`transpose sync failed: ${String(err)}`, 'error');
    console.error('Transpose sync failed:', err);
  }
});

// ── Headphone warning dismiss ─────────────────────────────────────────────────

warningDismiss.addEventListener('click', () => {
  headphoneWarning.classList.add('hidden');
});



btnSettings.addEventListener('click', async () => {
  const visible = settingsPanelEl.classList.toggle('visible');
  if (!visible) return;
  await refreshAudioSettings();
});

settingsDeviceEl.addEventListener('change', () => {
  const parsed = Number.parseInt(settingsDeviceEl.value, 10);
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

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (btnPlay.disabled) return;
    if (engine?.state === 'playing') {
      btnPause.click();
    } else {
      btnPlay.click();
    }
    return;
  }

  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    if (!btnRewind.disabled) btnRewind.click();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    void seekByBeats(-1);
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    void seekByBeats(1);
  }
});

// ── Drag-and-drop / file picker ───────────────────────────────────────────────

dropZoneEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZoneEl.classList.add('drag-over');
});

dropZoneEl.addEventListener('dragleave', () => {
  dropZoneEl.classList.remove('drag-over');
});

dropZoneEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZoneEl.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) void loadScore(file);
});

dropZoneEl.addEventListener('click', () => fileInputEl.click());
btnBrowse.addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', () => {
  const file = fileInputEl.files?.[0];
  if (file) void loadScore(file);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setTransportEnabled(enabled: boolean): void {
  btnPlay.disabled = !enabled;
  btnPause.disabled = !enabled;
  btnStop.disabled = !enabled;
  btnRewind.disabled = !enabled;
  partSelectEl.disabled = !enabled;
  tempoSliderEl.disabled = !enabled;
  transposeSelectEl.disabled = !enabled;
  btnBrowse.disabled = !enabled;
}

window.addEventListener('beforeunload', () => {
  closePitchSocket();
  pitchOverlay?.destroy();
});

// ── Init ──────────────────────────────────────────────────────────────────────

setTransportEnabled(false);
tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
settingsConfidenceEl.value = String(overlaySettings.confidenceThreshold);
settingsTrailEl.value = String(overlaySettings.trailMs / 1000);
updateSettingsLabels();
void checkBackend();
