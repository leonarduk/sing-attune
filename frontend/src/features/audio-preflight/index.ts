import { type Feature } from '../../feature-types';
import {
  loadPreflightDeviceId,
  loadPreflightLatencyMs,
  markAudioPreflightComplete,
  persistPreflightDeviceId,
  persistPreflightLatencyMs,
  registerAudioPreflightOpener,
} from '../../services/audio-preflight';

interface BrowserAudioInputDevice {
  deviceId: string;
  label: string;
}

let modalEl: HTMLDivElement | null = null;
let resolver: ((value: boolean) => void) | null = null;
let monitorCtx: AudioContext | null = null;
let monitorStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let meterRaf: number | null = null;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let monitorGain: GainNode | null = null;

let meterFillEl: HTMLDivElement | null = null;
let permissionStatusEl: HTMLDivElement | null = null;
let deviceSelectEl: HTMLSelectElement | null = null;
let latencyValueEl: HTMLSpanElement | null = null;
let errorEl: HTMLDivElement | null = null;
let testButtonEl: HTMLButtonElement | null = null;
let continueButtonEl: HTMLButtonElement | null = null;

let selectedDeviceId: string | null = loadPreflightDeviceId();
let isMonitoring = false;

function setError(message: string): void {
  if (errorEl) errorEl.textContent = message;
}

function setPermissionStatus(message: string): void {
  if (permissionStatusEl) permissionStatusEl.textContent = message;
}

function cleanupMonitor(): void {
  if (meterRaf !== null) {
    cancelAnimationFrame(meterRaf);
    meterRaf = null;
  }

  monitorGain?.disconnect();
  monitorSource?.disconnect();

  monitorStream?.getTracks().forEach((track) => track.stop());
  monitorStream = null;

  analyser = null;
  monitorSource = null;
  monitorGain = null;
  if (monitorCtx) {
    void monitorCtx.close().catch(() => undefined);
    monitorCtx = null;
  }
  isMonitoring = false;

  if (meterFillEl) meterFillEl.style.width = '0%';
  if (testButtonEl) testButtonEl.textContent = 'Test my mic';
}

async function loadInputDevices(): Promise<BrowserAudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  return inputs.map((d, index) => ({
    deviceId: d.deviceId,
    label: d.label || `Microphone ${index + 1}`,
  }));
}

function startLevelMeter(): void {
  if (!analyser || !meterFillEl) return;
  const data = new Uint8Array(analyser.fftSize);

  const tick = (): void => {
    if (!analyser || !meterFillEl) return;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const centered = (data[i] - 128) / 128;
      const mag = Math.abs(centered);
      if (mag > peak) peak = mag;
    }
    meterFillEl.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    meterRaf = requestAnimationFrame(tick);
  };

  meterRaf = requestAnimationFrame(tick);
}

async function ensureMonitorStream(): Promise<void> {
  cleanupMonitor();

  const constraints: MediaStreamConstraints = {
    audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
    video: false,
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  monitorStream = stream;
  if (!selectedDeviceId) {
    const [track] = stream.getAudioTracks();
    const settings = track?.getSettings();
    selectedDeviceId = settings?.deviceId ?? selectedDeviceId;
    persistPreflightDeviceId(selectedDeviceId);
  }

  const ctx = new AudioContext();
  monitorCtx = ctx;
  monitorSource = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  monitorSource.connect(analyser);
  startLevelMeter();
}

async function requestPermissionAndDevices(): Promise<void> {
  setError('');
  try {
    await ensureMonitorStream();
    const devices = await loadInputDevices();
    if (!deviceSelectEl) return;
    deviceSelectEl.innerHTML = devices
      .map((d) => `<option value="${d.deviceId}">${d.label}</option>`)
      .join('');

    if (selectedDeviceId) {
      const hasSaved = devices.some((d) => d.deviceId === selectedDeviceId);
      if (hasSaved) {
        deviceSelectEl.value = selectedDeviceId;
      } else if (devices.length > 0) {
        selectedDeviceId = devices[0].deviceId;
        deviceSelectEl.value = selectedDeviceId;
        persistPreflightDeviceId(selectedDeviceId);
      }
    }

    if (!selectedDeviceId && devices.length > 0) {
      selectedDeviceId = devices[0].deviceId;
      deviceSelectEl.value = selectedDeviceId;
      persistPreflightDeviceId(selectedDeviceId);
    }

    setPermissionStatus('Microphone permission granted.');
    if (continueButtonEl) continueButtonEl.disabled = false;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setPermissionStatus('Microphone permission denied or unavailable.');
    setError(`Could not access microphone: ${msg}`);
    cleanupMonitor();
    if (continueButtonEl) continueButtonEl.disabled = true;
  }
}

async function toggleMicTest(): Promise<void> {
  if (!monitorCtx || !analyser || !monitorSource) {
    await requestPermissionAndDevices();
    return;
  }

  if (!monitorGain) {
    monitorGain = monitorCtx.createGain();
    monitorGain.gain.value = 0;
    monitorSource.connect(monitorGain);
    monitorGain.connect(monitorCtx.destination);
  }

  isMonitoring = !isMonitoring;
  monitorGain.gain.value = isMonitoring ? 0.7 : 0;
  if (testButtonEl) testButtonEl.textContent = isMonitoring ? 'Stop mic test' : 'Test my mic';
}

function buildModal(): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.id = 'audio-preflight-modal';
  wrapper.className = 'audio-preflight hidden';
  wrapper.innerHTML = `
    <div class="audio-preflight-backdrop"></div>
    <div class="audio-preflight-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-preflight-title">
      <h2 id="audio-preflight-title">Audio setup</h2>
      <p class="audio-preflight-help">Before rehearsal, confirm your mic and latency setup.</p>
      <div id="audio-preflight-permission" class="audio-preflight-status">Microphone permission not requested yet.</div>
      <div class="audio-preflight-row">
        <label for="audio-preflight-device">Microphone</label>
        <select id="audio-preflight-device"></select>
      </div>
      <div class="audio-preflight-row">
        <label>Input level</label>
        <div class="audio-meter"><div id="audio-preflight-meter-fill" class="audio-meter-fill"></div></div>
      </div>
      <div class="audio-preflight-row">
        <label for="audio-preflight-latency">Latency compensation</label>
        <div>
          <input id="audio-preflight-latency" type="range" min="-250" max="500" step="10" />
          <span id="audio-preflight-latency-value"></span>
        </div>
      </div>
      <div class="audio-preflight-tip">🎧 Use headphones to avoid feedback and mic bleed.</div>
      <div id="audio-preflight-error" class="audio-preflight-error" role="alert"></div>
      <div class="audio-preflight-actions">
        <button id="audio-preflight-request" class="transport-btn">Allow microphone</button>
        <button id="audio-preflight-test" class="transport-btn">Test my mic</button>
        <button id="audio-preflight-continue" class="transport-btn" disabled>Start rehearsal</button>
      </div>
    </div>
  `;

  return wrapper;
}

function ensureStyles(): void {
  if (document.getElementById('audio-preflight-style')) return;
  const style = document.createElement('style');
  style.id = 'audio-preflight-style';
  style.textContent = `
    .audio-preflight.hidden { display: none; }
    .audio-preflight { position: fixed; inset: 0; z-index: 3000; }
    .audio-preflight-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
    .audio-preflight-dialog {
      position: relative;
      margin: 8vh auto;
      max-width: 560px;
      background: #101726;
      color: #eaf6ff;
      border: 1px solid #2f5f88;
      border-radius: 10px;
      padding: 16px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.35);
    }
    .audio-preflight-help { margin-top: 0; color: #b9d8ef; }
    .audio-preflight-row { display: grid; grid-template-columns: 170px 1fr; gap: 10px; align-items: center; margin: 10px 0; }
    .audio-meter { height: 12px; border-radius: 10px; border: 1px solid #1a5276; background: #111; overflow: hidden; }
    .audio-meter-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2ecc71, #f1c40f, #e74c3c); transition: width 60ms linear; }
    .audio-preflight-tip, .audio-preflight-status { background: #15293f; border: 1px solid #254f75; border-radius: 6px; padding: 8px; margin: 10px 0; }
    .audio-preflight-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .audio-preflight-error { min-height: 1.2em; color: #ff8e8e; }
    @media (max-width: 640px) {
      .audio-preflight-dialog { margin: 0; border-radius: 0; max-width: none; min-height: 100vh; }
      .audio-preflight-row { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

async function openModal(): Promise<boolean> {
  if (!modalEl) return false;
  modalEl.classList.remove('hidden');
  await requestPermissionAndDevices();
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function closeModal(completed: boolean): void {
  if (modalEl) modalEl.classList.add('hidden');
  monitorGain && (monitorGain.gain.value = 0);
  isMonitoring = false;
  if (testButtonEl) testButtonEl.textContent = 'Test my mic';
  if (completed) markAudioPreflightComplete();
  if (resolver) {
    resolver(completed);
    resolver = null;
  }
}

function mount(_slot: HTMLElement): void {
  ensureStyles();
  modalEl = buildModal();
  document.body.appendChild(modalEl);

  permissionStatusEl = document.getElementById('audio-preflight-permission') as HTMLDivElement;
  deviceSelectEl = document.getElementById('audio-preflight-device') as HTMLSelectElement;
  meterFillEl = document.getElementById('audio-preflight-meter-fill') as HTMLDivElement;
  latencyValueEl = document.getElementById('audio-preflight-latency-value') as HTMLSpanElement;
  errorEl = document.getElementById('audio-preflight-error') as HTMLDivElement;
  testButtonEl = document.getElementById('audio-preflight-test') as HTMLButtonElement;
  continueButtonEl = document.getElementById('audio-preflight-continue') as HTMLButtonElement;

  const requestButton = document.getElementById('audio-preflight-request') as HTMLButtonElement;
  const latencyEl = document.getElementById('audio-preflight-latency') as HTMLInputElement;

  const latencyMs = loadPreflightLatencyMs();
  latencyEl.value = String(latencyMs);
  latencyValueEl.textContent = `${latencyMs} ms`;

  requestButton.addEventListener('click', () => {
    void requestPermissionAndDevices();
  });

  deviceSelectEl.addEventListener('change', () => {
    selectedDeviceId = deviceSelectEl?.value ?? null;
    persistPreflightDeviceId(selectedDeviceId);
    void requestPermissionAndDevices();
  });

  latencyEl.addEventListener('input', () => {
    const value = Number.parseInt(latencyEl.value, 10);
    persistPreflightLatencyMs(value);
    if (latencyValueEl) latencyValueEl.textContent = `${value} ms`;
  });

  testButtonEl.addEventListener('click', () => {
    void toggleMicTest();
  });

  continueButtonEl.addEventListener('click', () => {
    closeModal(true);
  });

  registerAudioPreflightOpener(openModal);
}

function unmount(): void {
  cleanupMonitor();
  void monitorCtx?.close().catch(() => undefined);
  monitorCtx = null;
  modalEl?.remove();
  modalEl = null;
}

export const audioPreflightFeature: Feature = {
  id: 'slot-audio-preflight',
  mount,
  unmount,
};
