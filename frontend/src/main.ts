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

// ── Backend health ────────────────────────────────────────────────────────────

async function checkBackend(): Promise<void> {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version: string };
    setStatus(`backend ok (v${data.version})`, 'ok');
  } catch (err) {
    setStatus('backend unreachable', 'error');
    console.error('Backend health check failed:', err);
  }
}

function setStatus(msg: string, cls: 'ok' | 'error' | 'loading' | ''): void {
  statusEl.textContent = msg;
  statusEl.className = cls;
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
    setStatus('soundfont load failed — no audio', 'error');
  });
}

// ── Score loading ─────────────────────────────────────────────────────────────

async function loadScore(file: File): Promise<void> {
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
  scoreContainerEl.innerHTML = '';

  // Start soundfont loading in background (idempotent)
  ensureSoundfont();

  renderer = new ScoreRenderer(scoreContainerEl);
  try {
    const model = await renderer.load(file);

    // Populate part selector
    partSelectEl.innerHTML = model.parts
      .map((p) => `<option value="${p}">${p}</option>`)
      .join('');
    partSelectEl.disabled = model.parts.length <= 1;

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
      model.parts[0] ?? '',
      parseFloat(tempoSliderEl.value) / 100,
    );

    cursor = new ScoreCursor(renderer.osmd, model);
    setTransportEnabled(true);
    setStatus('score loaded', 'ok');
  } catch (err) {
    setStatus(String(err), 'error');
    console.error('Score load failed:', err);
    dropZoneEl.classList.remove('hidden');
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

// ── Transport controls ────────────────────────────────────────────────────────

btnPlay.addEventListener('click', () => {
  if (!engine || !cursor || !renderer?.scoreModel) return;

  // Show headphone warning on every play
  headphoneWarning.classList.remove('hidden');

  const fromBeat = engine.state === 'paused' ? engine.startBeat : 0;

  if (fromBeat === 0) {
    // Full reset: reposition cursor to start
    cursor.stop(); // resets OSMD cursor to beat 0 and hides it
    cursor.osmd.cursor.show();
  }

  engine.play(fromBeat);
  startCursorRaf();
});

btnPause.addEventListener('click', () => {
  if (!engine) return;
  engine.pause();
  stopCursorRaf();
});

btnStop.addEventListener('click', () => {
  if (!engine || !cursor) return;
  engine.stop();
  stopCursorRaf();
  cursor.stop();
  headphoneWarning.classList.add('hidden');
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
  if (engine.state === 'playing') {
    engine.stop();
    stopCursorRaf();
    cursor?.stop();
    cursor?.osmd.cursor.show();
    engine.play(0);
    startCursorRaf();
  }
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

// ── Init ──────────────────────────────────────────────────────────────────────

setTransportEnabled(false);
tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
void checkBackend();
