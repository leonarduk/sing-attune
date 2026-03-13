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
import { PitchOverlay } from './pitch/overlay';
import { parsePitchFrame, reconnectDelayMs } from './pitch/socket';
import { getVisiblePartOptions } from './part-options';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const statusEl        = document.getElementById('status')       as HTMLSpanElement;
const dropZoneEl      = document.getElementById('drop-zone')    as HTMLDivElement;
const fileInputEl     = document.getElementById('file-input')   as HTMLInputElement;
const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement;
const scoreInfoEl     = document.getElementById('score-info')   as HTMLDivElement;
const btnPlay         = document.getElementById('btn-play')     as HTMLButtonElement;
const btnPause        = document.getElementById('btn-pause')    as HTMLButtonElement;
const btnStop         = document.getElementById('btn-stop')     as HTMLButtonElement;
const partSelectEl    = document.getElementById('part-select')  as HTMLSelectElement;
const tempoSliderEl   = document.getElementById('tempo-slider') as HTMLInputElement;
const tempoLabelEl    = document.getElementById('tempo-label')  as HTMLSpanElement;
const headphoneWarning = document.getElementById('headphone-warning') as HTMLDivElement;
const warningDismiss  = document.getElementById('warning-dismiss') as HTMLButtonElement;
const scoreLoadingEl  = document.getElementById('score-loading') as HTMLDivElement;
const errorBannerEl   = document.getElementById('error-banner') as HTMLDivElement;
const showAccompanimentEl = document.getElementById('show-accompaniment') as HTMLInputElement;

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
    engine.schedule(
      model.notes,
      model.tempo_marks,
      selectedPart,
      parseFloat(tempoSliderEl.value) / 100,
    );

    cursor = new ScoreCursor(renderer.osmd, model);
    pitchOverlay = new PitchOverlay(scoreContainerEl, model, model.parts[0] ?? '');
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

async function callPlayback(path: 'start' | 'pause' | 'resume' | 'stop'): Promise<void> {
  const res = await fetch(`/playback/${path}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`playback ${path} failed (HTTP ${res.status})`);
  }
}

function scheduleSelectedPart(selectedPart: string): void {
  if (!engine || !renderer?.scoreModel) return;

  engine.schedule(
    renderer.scoreModel.notes,
    renderer.scoreModel.tempo_marks,
    selectedPart,
    parseFloat(tempoSliderEl.value) / 100,
  );

  if (engine.state === 'playing') {
    engine.stop();
    stopCursorRaf();
    cursor?.stop();
    cursor?.osmd.cursor.show();
    engine.play(0);
    startCursorRaf();
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

  try {
    if (engine.state === 'paused') {
      await callPlayback('resume');
      engine.play(engine.startBeat);
    } else {
      await callPlayback('start');
      cursor.stop();
      cursor.osmd.cursor.show();
      pitchOverlay?.clear();
      engine.play(0);
    }
    startCursorRaf();
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

btnPause.addEventListener('click', async () => {
  if (!engine) return;
  try {
    await callPlayback('pause');
    engine.pause();
    stopCursorRaf();
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

btnStop.addEventListener('click', async () => {
  if (!engine || !cursor) return;
  try {
    await callPlayback('stop');
    engine.stop();
    stopCursorRaf();
    cursor.stop();
    pitchOverlay?.clear();
    headphoneWarning.classList.add('hidden');
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

// ── Part selector ─────────────────────────────────────────────────────────────

partSelectEl.addEventListener('change', () => {
  if (!engine || !renderer?.scoreModel) return;
  const model = renderer.scoreModel;
  engine.schedule(
    model.notes,
    model.tempo_marks,
    partSelectEl.value,
    parseFloat(tempoSliderEl.value) / 100,
  );
  // If playing, restart from beat 0 with the new part
  pitchOverlay?.updatePart(partSelectEl.value);

  if (engine.state === 'playing') {
    engine.stop();
    stopCursorRaf();
    cursor?.stop();
    cursor?.osmd.cursor.show();
    pitchOverlay?.clear();
    engine.play(0);
    startCursorRaf();
  }
  scheduleSelectedPart(partSelectEl.value);
});

showAccompanimentEl.addEventListener('change', () => {
  refreshPartSelector();
});

// ── Tempo slider ──────────────────────────────────────────────────────────────

tempoSliderEl.addEventListener('input', () => {
  const mult = parseFloat(tempoSliderEl.value) / 100;
  tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
  // setTempoMultiplier() reschedules if playing, or stores for next play()
  engine?.setTempoMultiplier(mult);
});

// ── Headphone warning dismiss ─────────────────────────────────────────────────

warningDismiss.addEventListener('click', () => {
  headphoneWarning.classList.add('hidden');
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

fileInputEl.addEventListener('change', () => {
  const file = fileInputEl.files?.[0];
  if (file) void loadScore(file);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setTransportEnabled(enabled: boolean): void {
  btnPlay.disabled = !enabled;
  btnPause.disabled = !enabled;
  btnStop.disabled = !enabled;
  partSelectEl.disabled = !enabled;
  tempoSliderEl.disabled = !enabled;
}

window.addEventListener('beforeunload', () => {
  closePitchSocket();
  pitchOverlay?.destroy();
});

// ── Init ──────────────────────────────────────────────────────────────────────

setTransportEnabled(false);
tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
void checkBackend();
