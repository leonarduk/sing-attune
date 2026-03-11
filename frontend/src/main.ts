/**
 * sing-attune frontend entry point.
 * Day 8a: score file upload → OSMD render → wall-clock cursor.
 * Day 9+: pitch overlay wired to AudioContext.currentTime will call
 *         cursor.seekToBeat() directly, replacing the internal tick.
 */
import { ScoreRenderer } from './score/renderer';
import { ScoreCursor } from './score/cursor';

const statusEl = document.getElementById('status') as HTMLSpanElement;
const dropZoneEl = document.getElementById('drop-zone') as HTMLDivElement;
const fileInputEl = document.getElementById('file-input') as HTMLInputElement;
const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement;
const scoreInfoEl = document.getElementById('score-info') as HTMLDivElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;

let renderer: ScoreRenderer | null = null;
let cursor: ScoreCursor | null = null;

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

// ── Score loading ─────────────────────────────────────────────────────────────

async function loadScore(file: File): Promise<void> {
  setStatus(`Loading ${file.name}…`, 'loading');
  dropZoneEl.classList.add('hidden');
  scoreInfoEl.textContent = '';
  setTransportEnabled(false);

  // Reset previous state
  cursor?.stop();
  cursor = null;
  scoreContainerEl.innerHTML = '';

  renderer = new ScoreRenderer(scoreContainerEl);

  try {
    const model = await renderer.load(file);
    const bpm = model.tempo_marks[0]?.bpm ?? 120;
    scoreInfoEl.textContent =
      `${model.title} — ${model.parts.join(', ')} — ${bpm} bpm — ${model.total_beats.toFixed(0)} beats`;
    cursor = new ScoreCursor(renderer.osmd, model);
    setTransportEnabled(true);
    setStatus('score loaded', 'ok');
  } catch (err) {
    setStatus(String(err), 'error');
    console.error('Score load failed:', err);
    dropZoneEl.classList.remove('hidden');
  }
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

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
  if (file) loadScore(file);
});

dropZoneEl.addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', () => {
  const file = fileInputEl.files?.[0];
  if (file) loadScore(file);
});

// ── Transport controls ────────────────────────────────────────────────────────

btnPlay.addEventListener('click', () => cursor?.play());

btnPause.addEventListener('click', () => cursor?.pause());

btnStop.addEventListener('click', () => cursor?.stop());

function setTransportEnabled(enabled: boolean): void {
  btnPlay.disabled = !enabled;
  btnPause.disabled = !enabled;
  btnStop.disabled = !enabled;
}

// ── Init ──────────────────────────────────────────────────────────────────────

setTransportEnabled(false);
checkBackend();
