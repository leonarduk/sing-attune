import { type Feature } from '../../feature-types';
import {
  loadPreflightDeviceId,
  loadPreflightLatencyMs,
  loadOctaveCompensationEnabled,
  loadUserVoiceTypeId,
  markAudioPreflightComplete,
  persistOctaveCompensationEnabled,
  persistPreflightDeviceId,
  persistPreflightLatencyMs,
  persistUserVoiceTypeId,
  registerAudioPreflightOpener,
} from '../../services/audio-preflight';
import { VOICE_TYPES, getVoiceTypeById } from '../../pitch/voice-type';

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
let meterRunToken = 0;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let monitorGain: GainNode | null = null;

let meterFillEl: HTMLDivElement | null = null;
let permissionStatusEl: HTMLDivElement | null = null;
let deviceSelectEl: HTMLSelectElement | null = null;
let latencyValueEl: HTMLSpanElement | null = null;
let errorEl: HTMLDivElement | null = null;
let testButtonEl: HTMLButtonElement | null = null;
let continueButtonEl: HTMLButtonElement | null = null;
let requestButtonEl: HTMLButtonElement | null = null;
let voiceTypeSelectEl: HTMLSelectElement | null = null;
let voiceTypeSuggestionEl: HTMLDivElement | null = null;
let octaveCompCheckboxEl: HTMLInputElement | null = null;
const METER_GAIN_SCALE = 140;
let removeEscapeListener: (() => void) | null = null;

let selectedDeviceId: string | null = loadPreflightDeviceId();
let selectedVoiceTypeId: string | null = loadUserVoiceTypeId();
let isMonitoring = false;

function applyVoiceTypeSuggestionFromEvent(event: Event): void {
  const custom = event as CustomEvent<{ suggestedVoiceTypeId: string; message: string }>;
  const suggestedVoiceType = getVoiceTypeById(custom.detail.suggestedVoiceTypeId);
  if (!voiceTypeSuggestionEl || !suggestedVoiceType) return;
  voiceTypeSuggestionEl.textContent = custom.detail.message;

  if (!selectedVoiceTypeId) {
    selectedVoiceTypeId = suggestedVoiceType.id;
    persistUserVoiceTypeId(selectedVoiceTypeId);
    if (voiceTypeSelectEl) voiceTypeSelectEl.value = selectedVoiceTypeId;
  }

  if (suggestedVoiceType.male && octaveCompCheckboxEl && !loadOctaveCompensationEnabled()) {
    octaveCompCheckboxEl.checked = true;
    persistOctaveCompensationEnabled(true);
  }
}

function setError(message: string): void {
  if (errorEl) errorEl.textContent = message;
}

function setPermissionStatus(message: string): void {
  if (permissionStatusEl) permissionStatusEl.textContent = message;
}

function setRequestButtonVisibility(shouldShow: boolean): void {
  if (!requestButtonEl) return;
  requestButtonEl.style.display = shouldShow ? '' : 'none';
}

type MicrophonePermissionState = PermissionState | 'unsupported';

async function getMicrophonePermissionState(): Promise<MicrophonePermissionState> {
  if (!navigator.permissions?.query) return 'unsupported';

  try {
    const status = await navigator.permissions.query({
      // `microphone` is supported in modern browsers but not yet in TS libdom.
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

async function syncPermissionUiFromBrowserState(): Promise<void> {
  const permissionState = await getMicrophonePermissionState();
  if (permissionState === 'granted') {
    setPermissionStatus('Microphone permission granted.');
    setRequestButtonVisibility(false);
    if (continueButtonEl) continueButtonEl.disabled = false;
    return;
  }

  if (permissionState === 'denied') {
    setPermissionStatus('Microphone permission denied or unavailable.');
    setRequestButtonVisibility(true);
    if (continueButtonEl) continueButtonEl.disabled = true;
    return;
  }

  setRequestButtonVisibility(true);
}

function cleanupMonitor(): void {
  meterRunToken += 1;
  if (meterRaf !== null) {
    cancelAnimationFrame(meterRaf);
    meterRaf = null;
  }

  try {
    monitorGain?.disconnect();
  } catch {
    // No-op: some Web Audio implementations throw if already disconnected.
  }
  try {
    monitorSource?.disconnect();
  } catch {
    // No-op: some Web Audio implementations throw if already disconnected.
  }

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


function resolveSelectedDeviceId(
  devices: BrowserAudioInputDevice[],
  currentSelectedDeviceId: string | null,
): string | null {
  if (devices.length === 0) return null;
  const hasSelected = currentSelectedDeviceId
    ? devices.some((d) => d.deviceId === currentSelectedDeviceId)
    : false;
  return hasSelected ? currentSelectedDeviceId : devices[0].deviceId;
}

function startLevelMeter(): void {
  if (!analyser || !meterFillEl) return;
  const data = new Uint8Array(analyser.fftSize);
  const runToken = meterRunToken;

  const tick = (): void => {
    if (runToken !== meterRunToken) return;
    if (!analyser || !meterFillEl) return;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const centered = (data[i] - 128) / 128;
      const mag = Math.abs(centered);
      if (mag > peak) peak = mag;
    }
    meterFillEl.style.width = `${Math.min(100, Math.round(peak * METER_GAIN_SCALE))}%`;
    meterRaf = requestAnimationFrame(tick);
  };

  meterRaf = requestAnimationFrame(tick);
}

async function ensureMonitorStream(): Promise<void> {
  // Always clean up first; cleanupMonitor() closes and nulls monitorCtx.
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
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
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

    const resolvedDeviceId = resolveSelectedDeviceId(devices, selectedDeviceId);
    if (resolvedDeviceId !== selectedDeviceId) {
      selectedDeviceId = resolvedDeviceId;
      persistPreflightDeviceId(selectedDeviceId);
    }
    if (selectedDeviceId) {
      deviceSelectEl.value = selectedDeviceId;
    }

    setPermissionStatus('Microphone permission granted.');
    setRequestButtonVisibility(false);
    if (continueButtonEl) continueButtonEl.disabled = false;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setPermissionStatus('Microphone permission denied or unavailable.');
    setRequestButtonVisibility(true);
    setError(`Could not access microphone: ${msg}`);
    cleanupMonitor();
    if (continueButtonEl) continueButtonEl.disabled = true;
  }
}

async function toggleMicTest(): Promise<void> {
  if (!monitorCtx || !analyser || !monitorSource) {
    try {
      await requestPermissionAndDevices();
    } catch {
      isMonitoring = false;
      if (testButtonEl) testButtonEl.textContent = 'Test my mic';
      return;
    }
    if (!monitorCtx || !analyser || !monitorSource) return;
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
      <div class="audio-preflight-row">
        <label for="audio-preflight-voice-type">Voice type</label>
        <select id="audio-preflight-voice-type"></select>
      </div>
      <div id="audio-preflight-voice-suggestion" class="audio-preflight-status">Voice type suggestion: complete one session to get a recommendation.</div>
      <div class="audio-preflight-row">
        <label for="audio-preflight-octave-comp">Octave compensation</label>
        <input id="audio-preflight-octave-comp" type="checkbox" />
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
  if (resolver) {
    resolver(false);
    resolver = null;
  }
  modalEl.classList.remove('hidden');
  removeEscapeListener?.();
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || isPreflightModalHidden()) return;
    event.preventDefault();
    closeModal(false);
  };
  window.addEventListener('keydown', onEscape);
  removeEscapeListener = () => {
    window.removeEventListener('keydown', onEscape);
    removeEscapeListener = null;
  };
  void syncPermissionUiFromBrowserState();
  void requestPermissionAndDevices();
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function closeModal(completed: boolean): void {
  if (modalEl) modalEl.classList.add('hidden');
  removeEscapeListener?.();
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
  voiceTypeSelectEl = document.getElementById('audio-preflight-voice-type') as HTMLSelectElement;
  voiceTypeSuggestionEl = document.getElementById('audio-preflight-voice-suggestion') as HTMLDivElement;
  octaveCompCheckboxEl = document.getElementById('audio-preflight-octave-comp') as HTMLInputElement;

  requestButtonEl = document.getElementById('audio-preflight-request') as HTMLButtonElement;
  const latencyEl = document.getElementById('audio-preflight-latency') as HTMLInputElement;

  const latencyMs = loadPreflightLatencyMs();
  latencyEl.value = String(latencyMs);
  latencyValueEl.textContent = `${latencyMs} ms`;

  voiceTypeSelectEl.innerHTML = [
    '<option value="">Not set</option>',
    ...VOICE_TYPES.map((type) => `<option value="${type.id}">${type.label}</option>`),
  ].join('');
  if (selectedVoiceTypeId) voiceTypeSelectEl.value = selectedVoiceTypeId;
  octaveCompCheckboxEl.checked = loadOctaveCompensationEnabled();

  requestButtonEl.addEventListener('click', () => {
    void requestPermissionAndDevices();
  });

  void syncPermissionUiFromBrowserState();

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

  voiceTypeSelectEl.addEventListener('change', () => {
    selectedVoiceTypeId = voiceTypeSelectEl?.value || null;
    persistUserVoiceTypeId(selectedVoiceTypeId);
  });

  octaveCompCheckboxEl.addEventListener('change', () => {
    persistOctaveCompensationEnabled(Boolean(octaveCompCheckboxEl?.checked));
  });

  testButtonEl.addEventListener('click', () => {
    void toggleMicTest();
  });

  continueButtonEl.addEventListener('click', () => {
    closeModal(true);
  });

  registerAudioPreflightOpener(openModal);
  window.addEventListener('voice-type-suggested', applyVoiceTypeSuggestionFromEvent as EventListener);
}

function unmount(): void {
  cleanupMonitor();
  removeEscapeListener?.();
  if (resolver) {
    resolver(false);
    resolver = null;
  }
  // monitorCtx is already closed and nulled by cleanupMonitor()
  modalEl?.remove();
  modalEl = null;
  window.removeEventListener('voice-type-suggested', applyVoiceTypeSuggestionFromEvent as EventListener);
}

export const __audioPreflightInternals = {
  resolveSelectedDeviceId,
  isPreflightModalHidden,
  openModal,
  closeModal,
  setRequestButtonVisibility,
  getMicrophonePermissionState,
  syncPermissionUiFromBrowserState,
};

function isPreflightModalHidden(): boolean {
  return !modalEl || modalEl.classList.contains('hidden');
}

export const audioPreflightFeature: Feature = {
  id: 'slot-audio-preflight',
  mount,
  unmount,
};
