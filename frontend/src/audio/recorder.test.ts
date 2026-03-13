import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PracticeRecorder, getSupportedRecordingMimeType, nextRecordingState } from './recorder';

describe('nextRecordingState', () => {
  it('transitions idle -> recording -> recorded -> idle', () => {
    const recording = nextRecordingState('idle', { type: 'start' });
    expect(recording).toBe('recording');

    const recorded = nextRecordingState(recording, { type: 'stop' });
    expect(recorded).toBe('recorded');

    const idle = nextRecordingState(recorded, { type: 'discard' });
    expect(idle).toBe('idle');
  });

  it('ignores stop when not currently recording', () => {
    expect(nextRecordingState('idle', { type: 'stop' })).toBe('idle');
    expect(nextRecordingState('recorded', { type: 'stop' })).toBe('recorded');
  });
});

describe('PracticeRecorder', () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = (globalThis as { window?: Window }).window;
  const originalMediaRecorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAudio = (globalThis as { Audio?: typeof Audio }).Audio;
  const originalDocument = (globalThis as { document?: Document }).document;

  const fakeTrack = { stop: vi.fn() };
  const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
  const mediaRecorderInstances: FakeMediaRecorder[] = [];

  class FakeMediaRecorder {
    static isTypeSupported = vi.fn((type: string) => type === 'audio/webm');
    state: RecordingState = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    private stopListeners: Array<() => void> = [];

    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      if (options?.mimeType) this.mimeType = options.mimeType;
      mediaRecorderInstances.push(this);
    }

    start(): void {
      this.state = 'recording';
    }

    stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['fake']) });
      this.stopListeners.forEach((listener) => listener());
    }

    addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
      if (type !== 'stop') return;

      if (options?.once) {
        const wrapped = () => {
          this.removeEventListener('stop', wrapped);
          listener();
        };
        this.stopListeners.push(wrapped);
        return;
      }

      this.stopListeners.push(listener);
    }

    removeEventListener(type: string, listener: () => void): void {
      if (type !== 'stop') return;
      this.stopListeners = this.stopListeners.filter((candidate) => candidate !== listener);
    }
  }

  beforeEach(() => {
    fakeTrack.stop.mockClear();
    mediaRecorderInstances.length = 0;

    vi.stubGlobal('window', {} as Window);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    });

    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);

    URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    URL.revokeObjectURL = vi.fn();

    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Audio', vi.fn(() => ({ play })));

    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn(),
      })),
    } as unknown as Document);
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    const load = vi.fn();
    vi.stubGlobal('Audio', vi.fn(() => ({ play, pause, removeAttribute, load, src: '' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;

    if (originalWindow) {
      (globalThis as { window?: Window }).window = originalWindow;
    }

    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: originalNavigator,
      });
    }

    if (originalMediaRecorder) {
      (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder = originalMediaRecorder;
    }

    if (originalAudio) {
      (globalThis as { Audio?: typeof Audio }).Audio = originalAudio;
    }

    if (originalDocument) {
      (globalThis as { document?: Document }).document = originalDocument;
    }
  });

  it('records and stores a playable take', async () => {
    const recorder = new PracticeRecorder();

    await recorder.start();
    expect(recorder.state).toBe('recording');

    await recorder.stop();
    expect(recorder.state).toBe('recorded');
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(fakeTrack.stop).toHaveBeenCalledOnce();

    const audio = recorder.playLastTake();
    expect(audio).not.toBeNull();
  });

  it('cleans up stream when recorder creation fails', async () => {
    vi.stubGlobal(
      'MediaRecorder',
      class BrokenRecorder {
        static isTypeSupported = vi.fn(() => true);
        constructor() {
          throw new Error('recorder init failed');
        }
      } as unknown as typeof MediaRecorder,
    );

    const recorder = new PracticeRecorder();
    await expect(recorder.start()).rejects.toThrow('recorder init failed');
    expect(fakeTrack.stop).toHaveBeenCalledOnce();
    expect(recorder.state).toBe('idle');
  });

  it('discard revokes existing take URL and resets idle state', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.stop();

    recorder.discard();

    expect(recorder.state).toBe('idle');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('stop is safely idempotent while a stop is in progress', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();

    const activeRecorder = mediaRecorderInstances[0];
    activeRecorder.stop = vi.fn(function stop(this: FakeMediaRecorder) {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(['fake']) });
        (this as unknown as { stopListeners: Array<() => void> }).stopListeners.forEach((listener) => listener());
      }, 0);
    });

    await Promise.all([recorder.stop(), recorder.stop()]);

    expect(activeRecorder.stop).toHaveBeenCalledOnce();
    expect(recorder.state).toBe('recorded');
  });


  it('saves last take with file picker when available', async () => {
    const createWritable = vi.fn(async () => ({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }));
    const showSaveFilePicker = vi.fn(async () => ({ createWritable }));
    vi.stubGlobal('window', { showSaveFilePicker } as unknown as Window);

    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.stop();

    await expect(recorder.saveLastTake()).resolves.toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledOnce();
    expect(createWritable).toHaveBeenCalledOnce();
  });

  it('falls back to anchor download when file picker is unavailable', async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const link = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click,
      remove,
    };
    vi.stubGlobal('window', {} as Window);
    const createElement = vi.fn(() => link);
    const appendChild = vi.fn();
    vi.stubGlobal('document', {
      body: { appendChild },
      createElement,
    } as unknown as Document);

    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.stop();

    await expect(recorder.saveLastTake()).resolves.toBe(true);
    expect(createElement).toHaveBeenCalledWith('a');
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('supports MIME detection fallbacks', () => {
    expect(getSupportedRecordingMimeType()).toBe('audio/webm');
  });
});

type RecordingState = 'inactive' | 'recording';
