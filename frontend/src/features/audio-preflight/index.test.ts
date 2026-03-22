import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { audioPreflightFeature, __audioPreflightInternals } from './index';

let nextAnalyserPeak = 0;

function setAnalyserPeak(amplitude: number): void {
  nextAnalyserPeak = amplitude;
}

class MockAudioContext {
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;

  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);

  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as MediaStreamAudioSourceNode);

  createAnalyser = vi.fn(() => ({
    fftSize: 1024,
    getByteTimeDomainData: vi.fn((data: Uint8Array) => {
      data.fill(128);
      data[0] = Math.max(0, Math.min(255, Math.round(128 + nextAnalyserPeak * 128)));
    }),
  }) as unknown as AnalyserNode);

  createGain = vi.fn(() => ({
    gain: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as GainNode);
}

function installMediaMocks(options: { permissionState?: PermissionState; getUserMediaError?: Error } = {}): void {
  const getUserMedia = vi.fn(async () => {
    if (options.getUserMediaError) throw options.getUserMediaError;

    return {
      getAudioTracks: () => [
        {
          getSettings: () => ({ deviceId: 'dev-1' }),
          stop: vi.fn(),
        },
      ],
      getTracks: () => [{ stop: vi.fn() }],
    };
  });

  const queryPermission = vi.fn(async () =>
    ({
      state: options.permissionState ?? 'prompt',
    }) as PermissionStatus,
  );

  const enumerateDevices = vi.fn(async () => [
    { kind: 'audioinput', deviceId: 'dev-1', label: 'Mic 1' },
    { kind: 'audioinput', deviceId: 'dev-2', label: 'Mic 2' },
  ]);

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices,
    },
  });

  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: queryPermission },
  });

  vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext);
}

function openModalAndWaitUntilReady(): Promise<boolean> {
  return __audioPreflightInternals.openModal();
}


const rafQueue: FrameRequestCallback[] = [];

function flushAnimationFrames(count = 1): void {
  for (let i = 0; i < count; i += 1) {
    const callback = rafQueue.shift();
    if (!callback) return;
    callback(performance.now());
  }
}

beforeEach(() => {
  nextAnalyserPeak = 0;
  rafQueue.length = 0;
  vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  }) as typeof requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', vi.fn((handle: number) => {
    const index = handle - 1;
    if (index >= 0 && index < rafQueue.length) rafQueue.splice(index, 1);
  }) as typeof cancelAnimationFrame);
});

afterEach(() => {
  audioPreflightFeature.unmount?.();
  vi.unstubAllGlobals();
});
describe('audio preflight device selection', () => {
  it('returns null when no devices are available', () => {
    expect(__audioPreflightInternals.resolveSelectedDeviceId([], 'dev-1')).toBeNull();
  });

  it('keeps the selected device when it still exists', () => {
    const devices = [
      { deviceId: 'dev-1', label: 'Mic 1' },
      { deviceId: 'dev-2', label: 'Mic 2' },
    ];

    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, 'dev-2')).toBe('dev-2');
  });

  it('falls back to first available device when selected device is missing', () => {
    const devices = [
      { deviceId: 'dev-3', label: 'Mic 3' },
      { deviceId: 'dev-4', label: 'Mic 4' },
    ];

    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, 'missing')).toBe('dev-3');
    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, null)).toBe('dev-3');
  });
});

describe('audio preflight Escape handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);
  });

  it('pressing Escape while modal is open closes it', async () => {
    const openPromise = openModalAndWaitUntilReady();

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);

    await expect(openPromise).resolves.toBe(false);
    expect(__audioPreflightInternals.isPreflightModalHidden()).toBe(true);
    expect(event.defaultPrevented).toBe(true);

  });

  it('openModal called twice does not register duplicate Escape listeners', async () => {
    const openPromiseOne = openModalAndWaitUntilReady();
    const openPromiseTwo = openModalAndWaitUntilReady();

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(escapeEvent);

    await expect(openPromiseTwo).resolves.toBe(false);
    expect(__audioPreflightInternals.isPreflightModalHidden()).toBe(true);

    const secondEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);

    // Ensure we don't leave the first open promise pending forever in tests.
    __audioPreflightInternals.closeModal(false);
    await expect(openPromiseOne).resolves.toBe(false);

  });

  it('Escape listener is removed after closeModal', async () => {
    const openPromise = openModalAndWaitUntilReady();

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

  });

  it('Escape listener is removed after unmount', async () => {
    const openPromise = openModalAndWaitUntilReady();

    audioPreflightFeature.unmount?.();
    await expect(openPromise).resolves.toBe(false);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('cancel button closes the modal', async () => {
    const openPromise = openModalAndWaitUntilReady();
    const cancelButton = document.getElementById('audio-preflight-cancel') as HTMLButtonElement;

    cancelButton.click();

    await expect(openPromise).resolves.toBe(false);
    expect(__audioPreflightInternals.isPreflightModalHidden()).toBe(true);
  });

  it('close button closes the modal', async () => {
    const openPromise = openModalAndWaitUntilReady();
    const closeButton = document.getElementById('audio-preflight-close') as HTMLButtonElement;

    closeButton.click();

    await expect(openPromise).resolves.toBe(false);
    expect(__audioPreflightInternals.isPreflightModalHidden()).toBe(true);
  });

  it('backdrop click closes the modal', async () => {
    const openPromise = openModalAndWaitUntilReady();
    const backdrop = document.querySelector('.audio-preflight-backdrop') as HTMLDivElement;

    backdrop.click();

    await expect(openPromise).resolves.toBe(false);
    expect(__audioPreflightInternals.isPreflightModalHidden()).toBe(true);
  });
});


describe('audio preflight permission request button visibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);
  });

  it('hides the "Allow microphone" button once permission is granted', async () => {
    const openPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestButton = document.getElementById('audio-preflight-request') as HTMLButtonElement;
    expect(requestButton.style.display).toBe('none');

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);

  });

  it('hides the request button on mount when browser permission is already granted', async () => {

    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks({ permissionState: 'granted' });
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestButton = document.getElementById('audio-preflight-request') as HTMLButtonElement;
    const status = document.getElementById('audio-preflight-permission') as HTMLDivElement;
    const continueButton = document.getElementById('audio-preflight-continue') as HTMLButtonElement;

    expect(requestButton.style.display).toBe('none');
    expect(status.textContent).toBe('Microphone permission granted.');
    expect(continueButton.disabled).toBe(false);

  });

  it('keeps the "Allow microphone" button visible when permission request fails', async () => {

    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks({ getUserMediaError: new Error('permission denied') });
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    const openPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestButton = document.getElementById('audio-preflight-request') as HTMLButtonElement;
    expect(requestButton.style.display).toBe('');

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);

  });
});


describe('audio preflight mic test feedback', () => {
  it('classifies silence as no signal', () => {
    const summary = __audioPreflightInternals.classifyMicTestPeak(0.001);

    expect(summary.classification).toBe('no-signal');
    expect(summary.message).toContain('No signal detected');
    expect(summary.peakDbfs).not.toBeNull();
  });

  it('classifies low input as too quiet', () => {
    const summary = __audioPreflightInternals.classifyMicTestPeak(0.05);

    expect(summary.classification).toBe('too-quiet');
    expect(summary.message).toContain('Signal too quiet');
  });

  it('classifies healthy input as good', () => {
    const summary = __audioPreflightInternals.classifyMicTestPeak(0.2);

    expect(summary.classification).toBe('good');
    expect(summary.message).toContain('Microphone detected');
    expect(summary.message).toContain('dBFS');
  });

  it('classifies high input as too loud', () => {
    const summary = __audioPreflightInternals.classifyMicTestPeak(0.9);

    expect(summary.classification).toBe('too-loud');
    expect(summary.message).toContain('Signal too loud');
  });

  it('renders the mic feedback panel with an idle prompt and peak label', () => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    const result = document.getElementById('audio-preflight-test-result') as HTMLDivElement;
    const peak = document.getElementById('audio-preflight-meter-peak') as HTMLDivElement;

    expect(result.dataset.state).toBe('idle');
    expect(result.textContent).toContain('Run “Test my mic”');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');
  });

  it('maps zero amplitude to null dBFS for consistent silent UI output', () => {
    expect(__audioPreflightInternals.amplitudeToDbfs(0)).toBeNull();
    expect(__audioPreflightInternals.amplitudeToDbfs(-0.1)).toBeNull();
  });

  it('treats a full silent mic test session as no signal', async () => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    const openPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const testButton = document.getElementById('audio-preflight-test') as HTMLButtonElement;
    const result = document.getElementById('audio-preflight-test-result') as HTMLDivElement;
    const peak = document.getElementById('audio-preflight-meter-peak') as HTMLDivElement;

    setAnalyserPeak(0);
    testButton.click();
    flushAnimationFrames(3);
    testButton.click();

    expect(result.dataset.state).toBe('no-signal');
    expect(result.textContent).toContain('No signal detected');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);
  });

  it('does not reuse a previous run peak when the next run is silent', async () => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    const openPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const testButton = document.getElementById('audio-preflight-test') as HTMLButtonElement;
    const result = document.getElementById('audio-preflight-test-result') as HTMLDivElement;
    const peak = document.getElementById('audio-preflight-meter-peak') as HTMLDivElement;

    setAnalyserPeak(0.2);
    testButton.click();
    flushAnimationFrames(3);
    testButton.click();

    expect(result.dataset.state).toBe('good');
    expect(peak.textContent).not.toBe('Peak: —∞ dBFS');

    setAnalyserPeak(0);
    testButton.click();
    expect(result.textContent).toContain('Listening…');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');

    flushAnimationFrames(3);
    testButton.click();

    expect(result.dataset.state).toBe('no-signal');
    expect(result.textContent).toContain('No signal detected');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);
  });

  it('resets the mic test UI when the modal closes and reopens', async () => {
    document.body.innerHTML = '<div id="slot-audio-preflight"></div>';
    installMediaMocks();
    const slot = document.getElementById('slot-audio-preflight') as HTMLDivElement;
    audioPreflightFeature.mount(slot);

    const firstOpenPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const testButton = document.getElementById('audio-preflight-test') as HTMLButtonElement;
    const result = document.getElementById('audio-preflight-test-result') as HTMLDivElement;
    const peak = document.getElementById('audio-preflight-meter-peak') as HTMLDivElement;

    setAnalyserPeak(0.2);
    testButton.click();
    flushAnimationFrames(3);
    testButton.click();

    expect(result.dataset.state).toBe('good');

    __audioPreflightInternals.closeModal(false);
    await expect(firstOpenPromise).resolves.toBe(false);
    expect(result.dataset.state).toBe('idle');
    expect(result.textContent).toContain('Run “Test my mic”');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');

    const secondOpenPromise = openModalAndWaitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.dataset.state).toBe('idle');
    expect(result.textContent).toContain('Run “Test my mic”');
    expect(peak.textContent).toBe('Peak: —∞ dBFS');

    __audioPreflightInternals.closeModal(false);
    await expect(secondOpenPromise).resolves.toBe(false);
  });
});

