import { beforeEach, describe, expect, it, vi } from 'vitest';

import { audioPreflightFeature, __audioPreflightInternals } from './index';

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
    getByteTimeDomainData: vi.fn(),
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

    audioPreflightFeature.unmount?.();
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

    audioPreflightFeature.unmount?.();
  });

  it('Escape listener is removed after closeModal', async () => {
    const openPromise = openModalAndWaitUntilReady();

    __audioPreflightInternals.closeModal(false);
    await expect(openPromise).resolves.toBe(false);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    audioPreflightFeature.unmount?.();
  });

  it('Escape listener is removed after unmount', async () => {
    const openPromise = openModalAndWaitUntilReady();

    audioPreflightFeature.unmount?.();
    await expect(openPromise).resolves.toBe(false);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
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

    audioPreflightFeature.unmount?.();
  });

  it('hides the request button on mount when browser permission is already granted', async () => {
    audioPreflightFeature.unmount?.();

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

    audioPreflightFeature.unmount?.();
  });

  it('keeps the "Allow microphone" button visible when permission request fails', async () => {
    audioPreflightFeature.unmount?.();

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

    audioPreflightFeature.unmount?.();
  });
});
