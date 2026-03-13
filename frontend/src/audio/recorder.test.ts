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

  const fakeTrack = { stop: vi.fn() };
  const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
  const mediaRecorderInstances: FakeMediaRecorder[] = [];

  class FakeMediaRecorder {
    static isTypeSupported = vi.fn((type: string) => type === 'audio/webm');
    state: RecordingState = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

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
      this.onstop?.();
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
        this.onstop?.();
      }, 0);
    });

    await Promise.all([recorder.stop(), recorder.stop()]);

    expect(activeRecorder.stop).toHaveBeenCalledOnce();
    expect(recorder.state).toBe('recorded');
  });

  it('supports MIME detection fallbacks', () => {
    expect(getSupportedRecordingMimeType()).toBe('audio/webm');
  });
});

type RecordingState = 'inactive' | 'recording';
