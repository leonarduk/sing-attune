/**
 * pitch-overlay feature
 *
 * Owns:
 *  - WebSocket connection to /ws/pitch
 *  - Pitch graph (SVG-based scrolling strip)
 *  - Pitch diagnostics panel
 *  - Real-time pitch readout
 *  - Stable-note detection
 *  - Audio session recording controls
 *  - Settings panel wiring (audio devices, engine display, force-CPU toggle)
 *
 * Does NOT own:
 *  - Score loading / parsing (score-loader feature)
 *  - Score playback / scheduling (playback feature)
 *  - Part selection UI (part-selector feature)
 */

import type { ScoreModel } from '../../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const SOCKET_RECONNECT_DELAY_MS = 2_000;
const SOCKET_MAX_RECONNECT_DELAY_MS = 30_000;
const WS_KEEP_ALIVE_TIMEOUT_MS = 12_000;

// Pitch graph layout
const MIDI_MIN = 36;   // C2
const MIDI_MAX = 84;   // C6
const MIDI_RANGE = MIDI_MAX - MIDI_MIN;
const TIME_WINDOW_S = 10;
const TIME_WINDOW_MS = TIME_WINDOW_S * 1000;

// Pitch trail display
const TRAIL_DOT_R = 4;
const IN_TUNE_CENTS = 50;

// Stable note detection defaults
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_STABLE_MIN_CONF = 0.6;
const DEFAULT_STABLE_CLUSTER_CENTS = 35;
const DEFAULT_STABLE_HOLD_MS = 160;
const DEFAULT_STABLE_WINDOW_MS = 320;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PitchFrame {
  t: number;     // ms since play start
  midi: number;  // MIDI note with cent detail
  conf: number;  // 0–1 confidence
}

interface StableNoteState {
  active: boolean;
  startMs: number;
  midi: number;
  holdMs: number;
  windowMs: number;
  clusterCents: number;
  minConf: number;
  buffer: Array<{ t: number; midi: number; conf: number }>;
}

interface PhraseSummaryNote {
  midi: number;
  name: string;
  accuracy: 'green' | 'amber' | 'red' | 'none';
}

// ── Recording state ───────────────────────────────────────────────────────────

type RecordingState = 'idle' | 'recording' | 'has-take';

interface RecordingCtrl {
  state: RecordingState;
  frames: PitchFrame[];
  playhead: number;      // index during playback
  intervalId: number | undefined;
}

// ── Stable note detection ─────────────────────────────────────────────────────

function detectStableNote(
  state: StableNoteState,
  frame: PitchFrame,
): { fired: boolean; midi: number } {
  const now = frame.t;

  if (frame.conf < state.minConf) {
    state.buffer = [];
    return { fired: false, midi: 0 };
  }

  // Remove frames outside the sliding window
  state.buffer = state.buffer.filter(f => now - f.t <= state.windowMs);
  state.buffer.push(frame);

  if (state.buffer.length < 2) return { fired: false, midi: 0 };

  const midis = state.buffer.map(f => f.midi);
  const avg = midis.reduce((a, b) => a + b, 0) / midis.length;
  const spread = Math.max(...midis) - Math.min(...midis);
  const spreadCents = spread * 100;

  if (spreadCents > state.clusterCents) {
    return { fired: false, midi: 0 };
  }

  const span = now - state.buffer[0].t;
  if (span < state.holdMs) {
    return { fired: false, midi: 0 };
  }

  if (state.active && Math.abs(avg - state.midi) * 100 < state.clusterCents) {
    return { fired: false, midi: 0 };
  }

  state.active = true;
  state.startMs = now;
  state.midi = avg;
  state.buffer = [];
  return { fired: true, midi: avg };
}

// ── Phrase note summariser ─────────────────────────────────────────────────────

type NoteAccuracy = 'green' | 'amber' | 'red' | 'none';

function classifyAccuracy(stableNote: { midi: number }, expected: number | null): NoteAccuracy {
  if (expected === null) return 'none';
  const centsDiff = Math.abs(stableNote.midi - expected) * 100;
  if (centsDiff <= 50) return 'green';
  if (centsDiff <= 150) return 'amber';
  return 'red';
}

function buildPhraseSummaryHTML(notes: PhraseSummaryNote[]): string {
  if (notes.length === 0) {
    return '<p class="phrase-summary-empty">No stable notes detected in this phrase.</p>';
  }

  const badgeHTML = notes.map(n => {
    const cls = n.accuracy === 'none' ? '' : `phrase-badge-${n.accuracy}`;
    return `<span class="phrase-badge ${cls}">${n.name}</span>`;
  }).join('');

  return `
    <div class="phrase-summary-card">
      <div class="phrase-summary-title">Phrase summary</div>
      <div class="phrase-summary-notes">${badgeHTML}</div>
      <div class="phrase-summary-legend">🟢 &le;50¢ &nbsp; 🟡 &le;150¢ &nbsp; 🔴 &gt;150¢ &nbsp; ⬜ no target</div>
    </div>
  `;
}

// ── Pitch graph renderer ──────────────────────────────────────────────────────

function midiToNoteName(midi: number): string {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const note = Math.round(midi);
  const octave = Math.floor(note / 12) - 1;
  return `${names[note % 12]}${octave}`;
}

function renderPitchGraph(
  container: HTMLElement,
  frames: PitchFrame[],
  now: number,
  expectedMidiAtT: ((t: number) => number | null) | null,
  showNoteNames: boolean,
): void {
  const W = container.clientWidth  || 600;
  const H = container.clientHeight || 140;

  const tStart = now - TIME_WINDOW_MS;

  function xOf(t: number) { return ((t - tStart) / TIME_WINDOW_MS) * W; }
  function yOf(midi: number) { return H - ((midi - MIDI_MIN) / MIDI_RANGE) * H; }

  // ── Expected pitch band ────────────────────────────────────────────────────
  let bandSVG = '';
  if (expectedMidiAtT) {
    const STEPS = 200;
    let bandPath = '';
    const topPts: string[] = [];
    const botPts: string[] = [];

    for (let i = 0; i <= STEPS; i++) {
      const t = tStart + (i / STEPS) * TIME_WINDOW_MS;
      const m = expectedMidiAtT(t);
      if (m === null) { bandPath = ''; topPts.length = 0; botPts.length = 0; continue; }
      const x = xOf(t);
      topPts.push(`${x.toFixed(1)},${yOf(m + 0.5).toFixed(1)}`);
      botPts.push(`${x.toFixed(1)},${yOf(m - 0.5).toFixed(1)}`);
    }
    if (topPts.length > 1) {
      const pts = [...topPts, ...[...botPts].reverse()].join(' ');
      bandSVG = `<polygon points="${pts}" fill="rgba(100,160,255,0.18)" />`;
    }
  }

  // ── Pitch trail ────────────────────────────────────────────────────────────
  let pathSVG = '';
  let dotSVG  = '';

  const visible = frames.filter(f => f.t >= tStart && f.midi >= MIDI_MIN && f.midi <= MIDI_MAX);

  if (visible.length > 1) {
    type Segment = { color: string; pts: string[] };
    const segments: Segment[] = [];
    let cur: Segment | null = null;

    for (const f of visible) {
      const expected = expectedMidiAtT ? expectedMidiAtT(f.t) : null;
      const inTune = expected !== null && Math.abs(f.midi - expected) * 100 <= IN_TUNE_CENTS;
      const color = expected === null ? '#64748b' : (inTune ? '#4caf50' : '#ff9800');
      const pt = `${xOf(f.t).toFixed(1)},${yOf(f.midi).toFixed(1)}`;

      if (!cur || cur.color !== color) {
        if (cur) segments.push(cur);
        cur = { color, pts: cur ? [cur.pts[cur.pts.length - 1], pt] : [pt] };
      } else {
        cur.pts.push(pt);
      }
    }
    if (cur) segments.push(cur);

    const strokeWidth = 2;
    const dashArray = (color: string) => color === '#64748b' ? '4,3' : (color === '#ff9800' ? '6,3' : 'none');

    pathSVG = segments.map(s => {
      const d = `M ${s.pts.join(' L ')}`;
      const da = dashArray(s.color);
      const dash = da !== 'none' ? `stroke-dasharray="${da}"` : '';
      return `<path d="${d}" stroke="${s.color}" stroke-width="${strokeWidth}" fill="none" ${dash}/>`;
    }).join('');
  }

  const last = visible[visible.length - 1];
  if (last) {
    const expected = expectedMidiAtT ? expectedMidiAtT(last.t) : null;
    const inTune = expected !== null && Math.abs(last.midi - expected) * 100 <= IN_TUNE_CENTS;
    const color = expected === null ? '#64748b' : (inTune ? '#4caf50' : '#ff9800');
    const x = xOf(last.t);
    const y = yOf(last.midi);
    dotSVG  = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${TRAIL_DOT_R}" fill="${color}" />`;
    if (showNoteNames) {
      const label = midiToNoteName(last.midi);
      dotSVG += `<text x="${(x + 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${color}" font-size="10" font-family="monospace">${label}</text>`;
    }
  }

  container.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${bandSVG}${pathSVG}${dotSVG}</svg>`;
}

// ── Recording helpers ─────────────────────────────────────────────────────────

function refreshRecordingControls(ctrl: RecordingCtrl): void {
  const btnStart   = document.getElementById('btn-record-start')   as HTMLButtonElement | null;
  const btnStop    = document.getElementById('btn-record-stop')    as HTMLButtonElement | null;
  const btnPlay    = document.getElementById('btn-record-play')    as HTMLButtonElement | null;
  const btnSave    = document.getElementById('btn-record-save')    as HTMLButtonElement | null;
  const btnDiscard = document.getElementById('btn-record-discard') as HTMLButtonElement | null;
  const status     = document.getElementById('recording-status')   as HTMLElement | null;

  if (!btnStart || !btnStop || !btnPlay || !btnSave || !btnDiscard || !status) return;

  const idle = ctrl.state === 'idle';
  const recording = ctrl.state === 'recording';
  const hasTake = ctrl.state === 'has-take';

  btnStart.disabled   = !idle;
  btnStop.disabled    = !recording;
  btnPlay.disabled    = !hasTake;
  btnSave.disabled    = !hasTake;
  btnDiscard.disabled = !hasTake;

  status.textContent = recording ? '● Recording…' : (hasTake ? 'Take ready.' : '');
}

// ── Audio settings refresh ────────────────────────────────────────────────────

async function refreshAudioSettings(
  settingsDeviceEl: HTMLSelectElement,
  settingsEngineEl: HTMLDivElement,
  settingsCpuWarningEl: HTMLDivElement,
  settingsForceCpuEl: HTMLInputElement,
): Promise<void> {
  try {
    const [devicesRes, engineRes] = await Promise.all([fetch('/audio/devices'), fetch('/audio/engine')]);

    if (devicesRes.ok) {
      const dp = (await devicesRes.json()) as {
        default_device_id: number | null;
        devices: Array<{ id: number; name: string }>;
      };
      const prev = settingsDeviceEl.value;
      settingsDeviceEl.innerHTML = dp.devices
        .map(d => `<option value="${d.id}">${d.name}</option>`)
        .join('');
      const selectedDeviceId = prev
        ? (dp.devices.find(d => String(d.id) === prev) ? Number(prev) : dp.default_device_id)
        : dp.default_device_id;
      settingsDeviceEl.value = selectedDeviceId === null ? '' : String(selectedDeviceId);
      settingsDeviceEl.disabled = dp.devices.length === 0;
    }
    if (engineRes.ok) {
      const ep = (await engineRes.json()) as {
        active_engine: string;
        mode: string;
        cuda: boolean;
        device: string;
        force_cpu: boolean;
      };
      const engineLabel = ep.active_engine === 'torchcrepe' ? 'CREPE' : ep.active_engine;
      const deviceLabel = ep.active_engine === 'torchcrepe' && ep.cuda ? ep.device : 'CPU';
      settingsEngineEl.textContent = `Pitch engine: ${engineLabel} (${deviceLabel})`;
      settingsForceCpuEl.checked = ep.force_cpu;
      settingsCpuWarningEl.classList.toggle('visible', ep.active_engine !== 'torchcrepe');
    } else {
      settingsEngineEl.textContent = 'Pitch engine: unavailable';
      settingsCpuWarningEl.classList.remove('visible');
    }
  } catch (err) {
    settingsDeviceEl.innerHTML = '';
    settingsDeviceEl.disabled = true;
    settingsEngineEl.textContent = 'Pitch engine: unavailable';
    settingsCpuWarningEl.classList.remove('visible');
    showErrorBanner('Unable to load audio devices. Check backend audio permissions and retry.');
    console.error('Failed to load settings data:', err);
  }
}

// ── Error banner ──────────────────────────────────────────────────────────────

function showErrorBanner(message: string, autoDismissMs?: number): void {
  const banner = document.getElementById('error-banner');
  const msgEl  = document.getElementById('error-banner-message');
  const dismiss = document.getElementById('error-banner-dismiss');
  if (!banner || !msgEl) return;
  msgEl.textContent = message;
  banner.classList.add('visible');
  if (autoDismissMs) {
    setTimeout(() => banner.classList.remove('visible'), autoDismissMs);
    if (dismiss) dismiss.classList.add('hidden');
  } else {
    if (dismiss) dismiss.classList.remove('hidden');
  }
}

// ── Feature entry point ───────────────────────────────────────────────────────

function mount(_slot: HTMLElement): void {
  // ── DOM refs ───────────────────────────────────────────────────────────────
  const pitchReadoutEl  = document.getElementById('pitch-readout')         as HTMLElement;
  const graphContainer  = document.getElementById('pitch-graph-canvas')    as HTMLElement;
  const graphTitleEl    = document.getElementById('pitch-graph-title')     as HTMLElement | null;
  const settingsPanelEl = document.getElementById('settings-panel')        as HTMLElement;
  const btnSettings     = document.getElementById('btn-settings')          as HTMLButtonElement;
  const btnSettingsClose = document.getElementById('btn-settings-close')   as HTMLButtonElement;
  const settingsDeviceEl = document.getElementById('settings-device')      as HTMLSelectElement;
  const settingsConfEl  = document.getElementById('settings-confidence')   as HTMLInputElement;
  const settingsConfLabelEl = document.getElementById('settings-confidence-label') as HTMLSpanElement;
  const settingsTrailEl  = document.getElementById('settings-trail')       as HTMLInputElement;
  const settingsTrailLabelEl = document.getElementById('settings-trail-label')    as HTMLSpanElement;
  const settingsNoteNamesEl = document.getElementById('settings-show-note-names') as HTMLInputElement;
  const settingsSynthEl     = document.getElementById('settings-synthetic-mode')  as HTMLInputElement;
  const settingsForceCpuEl  = document.getElementById('settings-force-cpu')       as HTMLInputElement;
  const settingsEngineEl    = document.getElementById('settings-engine')           as HTMLDivElement;
  const settingsCpuWarningEl = document.getElementById('settings-cpu-warning')     as HTMLDivElement;
  const recordingEnabledEl  = document.getElementById('recording-enabled')        as HTMLInputElement;
  const btnStop             = document.getElementById('btn-stop')                 as HTMLButtonElement;
  const btnRewind           = document.getElementById('btn-rewind')               as HTMLButtonElement;
  const diagPanelEl         = document.getElementById('pitch-diagnostics-panel') as HTMLElement;
  const btnDiag             = document.getElementById('btn-diagnostics')         as HTMLButtonElement;
  const diagNoteEl          = document.getElementById('diag-note')               as HTMLElement;
  const diagCentsEl         = document.getElementById('diag-cents')              as HTMLElement;
  const diagStabilityEl     = document.getElementById('diag-stability')          as HTMLElement;
  const diagHeldEl          = document.getElementById('diag-held')               as HTMLElement;
  const diagConfEl          = document.getElementById('diag-confidence')         as HTMLElement;
  const diagConfFillEl      = document.getElementById('diag-confidence-fill')    as HTMLElement;
  const diagKeyboardEl      = document.getElementById('diag-keyboard')           as HTMLElement;
  const phraseSummaryEl     = document.getElementById('phrase-summary-panel')    as HTMLElement;
  const lastNoteEl          = document.getElementById('last-note-readout')       as HTMLElement;
  const stableConfEl        = document.getElementById('settings-stable-confidence') as HTMLInputElement | null;
  const stableConfLabelEl   = document.getElementById('settings-stable-confidence-label') as HTMLSpanElement | null;
  const stableClusterEl     = document.getElementById('settings-stable-cluster') as HTMLInputElement | null;
  const stableClusterLabelEl= document.getElementById('settings-stable-cluster-label') as HTMLSpanElement | null;
  const stableHoldEl        = document.getElementById('settings-stable-hold')    as HTMLInputElement | null;
  const stableHoldLabelEl   = document.getElementById('settings-stable-hold-label') as HTMLSpanElement | null;
  const stableWindowEl      = document.getElementById('settings-stable-window')  as HTMLInputElement | null;
  const stableWindowLabelEl = document.getElementById('settings-stable-window-label') as HTMLSpanElement | null;
  const warmupStatusEl      = document.getElementById('warmup-status')           as HTMLElement | null;
  const btnStartWarmup      = document.getElementById('btn-start-warmup')        as HTMLButtonElement | null;
  const btnStopWarmup       = document.getElementById('btn-stop-warmup')         as HTMLButtonElement | null;
  const btnStartRehearsal   = document.getElementById('btn-start-rehearsal')     as HTMLButtonElement | null;
  const warmupDurationEl    = document.getElementById('warmup-duration')         as HTMLSelectElement | null;
  const sessionRangeEl      = document.getElementById('session-range-readout')   as HTMLElement | null;
  const sessionRangeSummEl  = document.getElementById('session-range-summary')   as HTMLElement | null;
  const toastStackEl        = document.getElementById('toast-stack')             as HTMLElement | null;
  const errorBannerDismissEl = document.getElementById('error-banner-dismiss')   as HTMLButtonElement | null;
  const appStatusEl         = document.getElementById('app-status-text')         as HTMLElement | null;

  // ── State ──────────────────────────────────────────────────────────────────
  let frames: PitchFrame[] = [];
  let socket: WebSocket | null = null;
  let socketReconnectDelay = SOCKET_RECONNECT_DELAY_MS;
  let wsKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  let animFrame: number | null = null;
  let showNoteNames = settingsNoteNamesEl?.checked ?? false;
  let syntheticModeEnabled = false;
  let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  let trailDurationMs = 2000;
  let expectedMidiProvider: ((t: number) => number | null) | null = null;
  let diagnosticsVisible = false;
  let currentScorePartNames: string[] = [];
  const recording: RecordingCtrl = { state: 'idle', frames: [], playhead: 0, intervalId: undefined };

  // Stable-note detector state
  const stableState: StableNoteState = {
    active: false,
    startMs: 0,
    midi: 0,
    holdMs: DEFAULT_STABLE_HOLD_MS,
    windowMs: DEFAULT_STABLE_WINDOW_MS,
    clusterCents: DEFAULT_STABLE_CLUSTER_CENTS,
    minConf: DEFAULT_STABLE_MIN_CONF,
    buffer: [],
  };

  // Phrase summary state
  const phraseNotes: PhraseSummaryNote[] = [];

  // Session pitch range tracking
  let sessionMidiMin = Infinity;
  let sessionMidiMax = -Infinity;

  // Warmup state
  let warmupTimer: ReturnType<typeof setInterval> | null = null;
  let warmupSecondsLeft = 0;

  // ── Keyboard mini-visualiser ───────────────────────────────────────────────
  const KEYBOARD_MIDI_START = 48;  // C3
  const KEYBOARD_MIDI_END   = 72;  // C5
  const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);

  if (diagKeyboardEl) {
    diagKeyboardEl.innerHTML = Array.from(
      { length: KEYBOARD_MIDI_END - KEYBOARD_MIDI_START },
      (_, i) => {
        const semitone = (KEYBOARD_MIDI_START + i) % 12;
        return `<div class="diag-key${BLACK_NOTES.has(semitone) ? ' black' : ''}" data-midi="${KEYBOARD_MIDI_START + i}"></div>`;
      },
    ).join('');
  }

  // ── Toast notifications ────────────────────────────────────────────────────
  function showToast(message: string, variant: 'info' | 'warning' = 'info', durationMs = 4000): void {
    if (!toastStackEl) return;
    const el = document.createElement('div');
    el.className = `toast${variant === 'warning' ? ' warning' : ''}`;
    el.textContent = message;
    toastStackEl.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // ── App status bar ─────────────────────────────────────────────────────────
  function setAppStatus(text: string, tone: 'default' | 'success' | 'error' | 'warning' = 'default'): void {
    if (!appStatusEl) return;
    appStatusEl.textContent = text;
    appStatusEl.dataset['tone'] = tone === 'default' ? '' : tone;
  }

  // ── Error banner ───────────────────────────────────────────────────────────
  if (errorBannerDismissEl) {
    errorBannerDismissEl.addEventListener('click', () => {
      document.getElementById('error-banner')?.classList.remove('visible');
    });
  }

  // ── Settings controls ──────────────────────────────────────────────────────
  settingsConfEl?.addEventListener('input', () => {
    confidenceThreshold = Number(settingsConfEl.value);
    if (settingsConfLabelEl) settingsConfLabelEl.textContent = confidenceThreshold.toFixed(2);
  });

  settingsTrailEl?.addEventListener('input', () => {
    trailDurationMs = Number(settingsTrailEl.value) * 1000;
    if (settingsTrailLabelEl) settingsTrailLabelEl.textContent = `${settingsTrailEl.value}s`;
  });

  stableConfEl?.addEventListener('input', () => {
    stableState.minConf = Number(stableConfEl.value);
    if (stableConfLabelEl) stableConfLabelEl.textContent = Number(stableConfEl.value).toFixed(2);
  });
  stableClusterEl?.addEventListener('input', () => {
    stableState.clusterCents = Number(stableClusterEl.value);
    if (stableClusterLabelEl) stableClusterLabelEl.textContent = `${stableClusterEl.value} cents`;
  });
  stableHoldEl?.addEventListener('input', () => {
    stableState.holdMs = Number(stableHoldEl.value);
    if (stableHoldLabelEl) stableHoldLabelEl.textContent = `${stableHoldEl.value} ms`;
  });
  stableWindowEl?.addEventListener('input', () => {
    stableState.windowMs = Number(stableWindowEl.value);
    if (stableWindowLabelEl) stableWindowLabelEl.textContent = `${stableWindowEl.value} ms`;
  });

  settingsNoteNamesEl?.addEventListener('change', () => { showNoteNames = settingsNoteNamesEl.checked; });

  // ── Diagnostics toggle ─────────────────────────────────────────────────────
  btnDiag?.addEventListener('click', () => {
    diagnosticsVisible = !diagnosticsVisible;
    diagPanelEl?.classList.toggle('visible', diagnosticsVisible);
    btnDiag.classList.toggle('active', diagnosticsVisible);
  });

  // ── Warmup timer ───────────────────────────────────────────────────────────
  function stopWarmup() {
    if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
    if (warmupStatusEl) warmupStatusEl.textContent = 'Warm-up idle.';
    if (btnStartWarmup) btnStartWarmup.classList.remove('hidden');
    if (btnStopWarmup) btnStopWarmup.classList.add('hidden');
    if (btnStartRehearsal) btnStartRehearsal.classList.remove('hidden');
  }

  btnStartWarmup?.addEventListener('click', () => {
    const dur = warmupDurationEl ? Number(warmupDurationEl.value) : 120;
    warmupSecondsLeft = dur;
    if (warmupStatusEl) warmupStatusEl.textContent = `Warm-up: ${dur}s remaining`;
    if (btnStartWarmup) btnStartWarmup.classList.add('hidden');
    if (btnStopWarmup) btnStopWarmup.classList.remove('hidden');
    if (btnStartRehearsal) btnStartRehearsal.classList.add('hidden');
    warmupTimer = setInterval(() => {
      warmupSecondsLeft--;
      if (warmupSecondsLeft <= 0) {
        stopWarmup();
        showToast('Warm-up complete! Start rehearsing when ready.', 'info', 5000);
      } else {
        if (warmupStatusEl) warmupStatusEl.textContent = `Warm-up: ${warmupSecondsLeft}s remaining`;
      }
    }, 1000);
  });
  btnStopWarmup?.addEventListener('click', stopWarmup);
  btnStartRehearsal?.addEventListener('click', () => {
    document.getElementById('btn-play')?.click();
  });

  settingsForceCpuEl.addEventListener('change', async () => {
    try {
      const params = new URLSearchParams({ force_cpu: String(settingsForceCpuEl.checked) });
      const res = await fetch(`/audio/engine/force-cpu?${params.toString()}`, { method: 'POST' });
      if (!res.ok) throw new Error(`/audio/engine/force-cpu HTTP ${res.status}`);
      await refreshAudioSettings(settingsDeviceEl, settingsEngineEl, settingsCpuWarningEl, settingsForceCpuEl);
    } catch (err) {
      showErrorBanner('Unable to switch pitch engine mode.');
      console.error('Failed to update pitch engine mode:', err);
    }
  });

  settingsSynthEl.addEventListener('change', () => {
    syntheticModeEnabled = settingsSynthEl.checked;
    closePitchSocket();
    if (syntheticModeEnabled) {
      setAppStatus('Synthetic mode — WebSocket disconnected', 'warning');
    } else {
      openPitchSocket();
    }
  });

  settingsDeviceEl.addEventListener('change', async () => {
    const deviceId = settingsDeviceEl.value ? Number(settingsDeviceEl.value) : null;
    try {
      const url = deviceId !== null
        ? `/playback/start?device_id=${deviceId}`
        : '/playback/start';
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) console.warn('Device change: /playback/start returned', res.status);
    } catch (err) {
      console.error('Failed to change device:', err);
    }
  });

  // ── Recording controls ─────────────────────────────────────────────────────
  recordingEnabledEl?.addEventListener('change', () => {
    if (!recordingEnabledEl.checked) {
      recording.state = 'idle';
      recording.frames = [];
      refreshRecordingControls(recording);
    }
  });

  document.getElementById('btn-record-start')?.addEventListener('click', () => {
    recording.state = 'recording';
    recording.frames = [];
    refreshRecordingControls(recording);
  });

  document.getElementById('btn-record-stop')?.addEventListener('click', () => {
    recording.state = recording.frames.length > 0 ? 'has-take' : 'idle';
    refreshRecordingControls(recording);
  });

  document.getElementById('btn-record-play')?.addEventListener('click', () => {
    if (recording.state !== 'has-take' || recording.frames.length === 0) return;
    let i = 0;
    recording.intervalId = window.setInterval(() => {
      if (i >= recording.frames.length) { clearInterval(recording.intervalId); return; }
      handleFrame(recording.frames[i++]);
    }, 50);
  });

  document.getElementById('btn-record-save')?.addEventListener('click', () => {
    if (recording.frames.length === 0) return;
    const blob = new Blob([JSON.stringify(recording.frames, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `pitch-take-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-record-discard')?.addEventListener('click', () => {
    recording.state = 'idle';
    recording.frames = [];
    refreshRecordingControls(recording);
  });

  // ── Settings panel open/close ──────────────────────────────────────────────
  async function openSettingsPanel(): Promise<void> {
    settingsPanelEl.classList.add('visible');
    btnSettings.setAttribute('aria-expanded', 'true');
    await refreshAudioSettings(settingsDeviceEl, settingsEngineEl, settingsCpuWarningEl, settingsForceCpuEl);
  }

  function closeSettingsPanel(): void {
    settingsPanelEl.classList.remove('visible');
    btnSettings.setAttribute('aria-expanded', 'false');
  }

  btnSettings.addEventListener('click', async () => {
    if (settingsPanelEl.classList.contains('visible')) {
      closeSettingsPanel();
    } else {
      await openSettingsPanel();
    }
  });

  btnSettingsClose.addEventListener('click', closeSettingsPanel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsPanelEl.classList.contains('visible')) {
      closeSettingsPanel();
    }
  });

  // ── WebSocket management ───────────────────────────────────────────────────
  function resetKeepAliveTimer() {
    if (wsKeepAliveTimer) clearTimeout(wsKeepAliveTimer);
    wsKeepAliveTimer = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        console.warn('WS keep-alive timeout — reconnecting');
        socket.close();
      }
    }, WS_KEEP_ALIVE_TIMEOUT_MS);
  }

  function openPitchSocket() {
    if (syntheticModeEnabled) return;
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl   = `${wsProto}://${window.location.host}/ws/pitch`;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      socketReconnectDelay = SOCKET_RECONNECT_DELAY_MS;
      resetKeepAliveTimer();
      setAppStatus('Connected', 'success');
    };

    socket.onmessage = (ev) => {
      resetKeepAliveTimer();
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if ('ping' in msg || 'status' in msg) return;
      const frame = msg as unknown as PitchFrame;
      if (typeof frame.t !== 'number' || typeof frame.midi !== 'number') return;
      if (frame.conf < confidenceThreshold) return;
      handleFrame(frame);
      if (recording.state === 'recording') recording.frames.push(frame);
    };

    socket.onclose = () => {
      if (wsKeepAliveTimer) clearTimeout(wsKeepAliveTimer);
      if (!syntheticModeEnabled) {
        setAppStatus(`Reconnecting in ${socketReconnectDelay / 1000}s…`, 'warning');
        setTimeout(openPitchSocket, socketReconnectDelay);
        socketReconnectDelay = Math.min(socketReconnectDelay * 1.5, SOCKET_MAX_RECONNECT_DELAY_MS);
      }
    };

    socket.onerror = () => { socket?.close(); };
  }

  function closePitchSocket() {
    socket?.close();
    socket = null;
    if (wsKeepAliveTimer) clearTimeout(wsKeepAliveTimer);
  }

  // ── Frame handling ─────────────────────────────────────────────────────────
  function handleFrame(frame: PitchFrame) {
    frames.push(frame);

    // Trim trail
    const cutoff = frame.t - trailDurationMs;
    while (frames.length > 1 && frames[0].t < cutoff) frames.shift();

    // Update session pitch range
    if (frame.midi > 0) {
      if (frame.midi < sessionMidiMin) {
        sessionMidiMin = frame.midi;
        if (sessionRangeEl) {
          sessionRangeEl.textContent = `Session range: ${midiToNoteName(sessionMidiMin)}–${midiToNoteName(sessionMidiMax)}`;
        }
      }
      if (frame.midi > sessionMidiMax) {
        sessionMidiMax = frame.midi;
        if (sessionRangeEl) {
          sessionRangeEl.textContent = `Session range: ${midiToNoteName(sessionMidiMin)}–${midiToNoteName(sessionMidiMax)}`;
        }
      }
    }

    // Readout
    const noteName = midiToNoteName(frame.midi);
    if (pitchReadoutEl) pitchReadoutEl.textContent = showNoteNames
      ? `Detected: ${noteName} (${frame.midi.toFixed(1)}) conf=${frame.conf.toFixed(2)}`
      : `Detected: ${frame.midi.toFixed(1)} conf=${frame.conf.toFixed(2)}`;

    // Diagnostics
    if (diagnosticsVisible) {
      diagNoteEl.textContent  = noteName;
      diagCentsEl.textContent = `${((frame.midi % 1) * 100 - 50).toFixed(0)} ¢`;
      diagConfEl.textContent  = frame.conf.toFixed(2);
      diagConfFillEl.style.width = `${frame.conf * 100}%`;
      diagConfFillEl.style.background = frame.conf >= 0.7 ? '#4caf50' : (frame.conf >= 0.5 ? '#ffa726' : '#ef5350');

      const activeKey = diagKeyboardEl?.querySelector('[data-midi].active');
      activeKey?.classList.remove('active');
      const newKey = diagKeyboardEl?.querySelector(`[data-midi="${Math.round(frame.midi)}"]`);
      newKey?.classList.add('active');
    }

    // Stable note detection
    const { fired, midi: stableMidi } = detectStableNote(stableState, frame);
    if (fired) {
      const expected = expectedMidiProvider ? expectedMidiProvider(frame.t) : null;
      const accuracy = classifyAccuracy({ midi: stableMidi }, expected);
      const name = midiToNoteName(stableMidi);

      phraseNotes.push({ midi: stableMidi, name, accuracy });
      if (phraseSummaryEl) phraseSummaryEl.innerHTML = buildPhraseSummaryHTML(phraseNotes);

      if (lastNoteEl) {
        lastNoteEl.textContent = `Sung: ${name} | Expected: ${expected !== null ? midiToNoteName(expected) : '—'}`;
        lastNoteEl.className = accuracy === 'none' ? 'no-target' : (accuracy === 'green' ? 'in-tune' : 'out-of-tune');
        lastNoteEl.classList.remove('hidden');
      }
    }

    // Diagnostics stability
    if (diagnosticsVisible) {
      if (stableState.buffer.length >= 2) {
        const spread = (Math.max(...stableState.buffer.map(f => f.midi)) - Math.min(...stableState.buffer.map(f => f.midi))) * 100;
        diagStabilityEl.textContent = spread <= stableState.clusterCents ? 'Stable' : 'Unstable';
        diagStabilityEl.className = `diag-value ${spread <= stableState.clusterCents ? '' : 'unstable'}`;
        const held = stableState.buffer.length >= 2
          ? (frame.t - stableState.buffer[0].t) / 1000
          : 0;
        diagHeldEl.textContent = `${held.toFixed(1)}s`;
      } else {
        diagStabilityEl.textContent = 'No signal';
        diagStabilityEl.className = 'diag-value';
        diagHeldEl.textContent = '0.0s';
      }
    }
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  function renderLoop() {
    const now = frames.length > 0 ? frames[frames.length - 1].t : 0;
    renderPitchGraph(graphContainer, frames, now, expectedMidiProvider, showNoteNames);
    animFrame = requestAnimationFrame(renderLoop);
  }

  // ── Public API (consumed by other features via window events) ─────────────
  window.addEventListener('pitch-overlay:set-expected-midi-provider', (e) => {
    const ev = e as CustomEvent<{ provider: ((t: number) => number | null) | null }>;
    expectedMidiProvider = ev.detail.provider;
    phraseNotes.length = 0;
    if (phraseSummaryEl) phraseSummaryEl.innerHTML = '<p class="phrase-summary-empty">Phrase summary will appear after a phrase completes.</p>';
    if (lastNoteEl) lastNoteEl.classList.add('hidden');
  });

  window.addEventListener('pitch-overlay:set-score', (e) => {
    const ev = e as CustomEvent<{ score: ScoreModel }>;
    currentScorePartNames = ev.detail.score.parts.map(p => p.name);
    if (graphTitleEl) graphTitleEl.textContent = `Pitch graph (C2–C6, 10s window) — ${currentScorePartNames.join(', ')}`;
  });

  // ── Session range summary ─────────────────────────────────────────────────
  btnStop?.addEventListener('click', () => {
    if (sessionRangeSummEl && sessionMidiMin !== Infinity) {
      sessionRangeSummEl.textContent = `Last session range: ${midiToNoteName(sessionMidiMin)}–${midiToNoteName(sessionMidiMax)}`;
    }
    sessionMidiMin = Infinity;
    sessionMidiMax = -Infinity;
    if (sessionRangeEl) sessionRangeEl.textContent = 'Session range: —';
    phraseNotes.length = 0;
    if (phraseSummaryEl) phraseSummaryEl.innerHTML = '<p class="phrase-summary-empty">Phrase summary will appear after a phrase completes.</p>';
    if (lastNoteEl) lastNoteEl.classList.add('hidden');
  });

  btnRewind?.addEventListener('click', () => {
    phraseNotes.length = 0;
    if (phraseSummaryEl) phraseSummaryEl.innerHTML = '<p class="phrase-summary-empty">Phrase summary will appear after a phrase completes.</p>';
    if (lastNoteEl) lastNoteEl.classList.add('hidden');
  });

  // ── Synthetic mode: inject frames on keypress (for testing) ───────────────
  document.addEventListener('keydown', (e) => {
    if (!syntheticModeEnabled) return;
    const map: Record<string, number> = {
      'a': 60, 's': 62, 'd': 64, 'f': 65, 'g': 67, 'h': 69, 'j': 71, 'k': 72,
    };
    if (map[e.key] !== undefined) {
      const t = performance.now();
      handleFrame({ t, midi: map[e.key], conf: 0.9 });
    }
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  openPitchSocket();
  renderLoop();
}

export { mount };
