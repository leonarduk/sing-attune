import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/score-session', () => ({
  getSession: () => null,
  onScoreLoaded: () => () => {},
  onScoreCleared: () => () => {},
  onPartChanged: () => () => {},
}));

vi.mock('../../services/playback-sync', () => ({
  onPlaybackSyncEvent: () => () => {},
}));

vi.mock('../../services/backend', () => ({ showErrorBanner: vi.fn() }));
vi.mock('../../services/cursor-projection', () => ({ getFrameXPosition: () => 0 }));
vi.mock('../../pitch/overlay', () => ({
  MIN_CONFIDENCE_THRESHOLD: 0.6,
  PitchOverlay: class {
    pushFrame(): void {}
    clear(): void {}
    destroy(): void {}
    applySettings(): void {}
  },
}));
vi.mock('../../pitch/graph', () => ({
  PitchGraphCanvas: class {
    clear(): void {}
    destroy(): void {}
    tick(): void {}
    pushFrame(): void {}
    setRange(): void {}
    resetRange(): void {}
    autoCenterOnMidi(): void {}
  },
}));
vi.mock('../../pitch/accuracy', () => ({
  expectedNoteAtBeat: () => null,
  GREEN_CENTS_THRESHOLD: 20,
  AMBER_CENTS_THRESHOLD: 50,
}));
vi.mock('../../pitch/synthetic', () => ({ syntheticPitchFrameAt: () => ({ t: 0, midi: 60, conf: 1 }) }));
vi.mock('../../warmup/session', () => ({
  buildWarmupSequence: () => [{ startMs: 0, endMs: 120000, midi: 60, exercise: 'sirens' }],
  warmupMidiAt: () => 60,
  WarmupTonePlayer: class {
    playExpectedMidi(): void {}
  },
}));
vi.mock('../../pitch/timeline-sync', () => ({
  PitchTimelineSync: class {
    isFrameStale(): boolean { return false; }
    reset(): void {}
    setSyncOffsetMs(): void {}
    reanchor(): void {}
    audioToFrameTime(): number { return 0; }
  },
}));
vi.mock('../../pitch/socket', () => ({
  parsePitchSocketMessage: () => ({ kind: 'noop' }),
  reconnectDelayMs: () => 10,
}));
vi.mock('../../pitch/note-name', () => ({ midiToNoteName: () => 'C4' }));
vi.mock('../../pitch/session-range', () => ({
  SessionRangeTracker: class {
    summary(): null { return null; }
    ingest(): boolean { return false; }
    reset(): void {}
  },
}));
vi.mock('../../pitch/voice-type', () => ({ classifyVoiceType: () => null, getVoiceTypeById: () => null }));
vi.mock('../../score/timing', () => ({ elapsedToBeat: () => 0 }));
vi.mock('../../pitch/phrase-summary', () => ({
  PhraseSummaryTracker: class {
    pushFrame(): [] { return []; }
    reset(): void {}
  },
}));
vi.mock('../../audio/devices', () => ({ resolveSelectedDeviceId: () => null }));
vi.mock('../../audio/recorder', () => ({
  PracticeRecorder: class {
    static isSupported(): boolean { return false; }
    state: 'idle' | 'recording' | 'recorded' = 'idle';
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    playLastTake(): boolean { return false; }
    async saveLastTake(): Promise<boolean> { return false; }
    discard(): void {}
    destroy(): void {}
  },
}));
vi.mock('../../score-analyser', () => ({ analysePartPitchRange: () => null }));
vi.mock('../../services/audio-preflight', () => ({ loadUserVoiceTypeId: () => null }));

import { pitchOverlayFeature } from './index';

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close(): void {}
}

describe('pitchOverlayFeature warm-up controls', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="slot-pitch-overlay"></div>
      <div id="score-container"></div>
      <select id="warmup-duration"><option value="120" selected>120</option></select>
      <button id="btn-start-warmup">Start warm-up</button>
      <button id="btn-stop-warmup">Stop warm-up</button>
      <button id="btn-start-rehearsal">Start rehearsal</button>
      <div id="pitch-graph-canvas"></div>
      <div id="settings-panel"></div>
      <button id="btn-settings"></button>
      <button id="btn-settings-close"></button>
      <select id="settings-device"></select>
      <input id="settings-confidence" />
      <span id="settings-confidence-label"></span>
      <input id="settings-trail" />
      <span id="settings-trail-label"></span>
      <input id="settings-show-note-names" type="checkbox" />
      <input id="settings-synthetic-mode" type="checkbox" />
      <input id="settings-force-cpu" type="checkbox" />
      <div id="settings-engine"></div>
      <div id="settings-cpu-warning"></div>
      <input id="recording-enabled" type="checkbox" />
      <button id="btn-stop"></button>
      <button id="btn-rewind"></button>
      <button id="btn-record-start"></button>
      <button id="btn-record-stop"></button>
      <button id="btn-record-play"></button>
      <button id="btn-record-save"></button>
      <button id="btn-record-discard"></button>
      <div id="recording-status"></div>
      <span id="warmup-status"></span>
      <span id="pitch-readout"></span>
      <div id="last-note-readout"></div>
      <span id="session-range-readout"></span>
      <span id="session-range-summary"></span>
      <span id="pitch-graph-title"></span>
      <div id="phrase-summary-panel"></div>
      <button id="btn-play"></button>
    `;

    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('shows start and hides stop while warm-up is idle', () => {
    const slot = document.getElementById('slot-pitch-overlay') as HTMLDivElement;
    pitchOverlayFeature.mount(slot);

    const start = document.getElementById('btn-start-warmup') as HTMLButtonElement;
    const stop = document.getElementById('btn-stop-warmup') as HTMLButtonElement;

    expect(start.classList.contains('hidden')).toBe(false);
    expect(start.disabled).toBe(false);
    expect(stop.classList.contains('hidden')).toBe(true);
    expect(stop.disabled).toBe(true);
  });

  it('hides start and shows stop while warm-up is active', () => {
    const slot = document.getElementById('slot-pitch-overlay') as HTMLDivElement;
    pitchOverlayFeature.mount(slot);

    const start = document.getElementById('btn-start-warmup') as HTMLButtonElement;
    const stop = document.getElementById('btn-stop-warmup') as HTMLButtonElement;
    start.click();

    expect(start.classList.contains('hidden')).toBe(true);
    expect(start.disabled).toBe(true);
    expect(stop.classList.contains('hidden')).toBe(false);
    expect(stop.disabled).toBe(false);
  });

  it('resets warm-up state and status when stopWarmup runs', () => {
    const slot = document.getElementById('slot-pitch-overlay') as HTMLDivElement;
    pitchOverlayFeature.mount(slot);

    const start = document.getElementById('btn-start-warmup') as HTMLButtonElement;
    const stop = document.getElementById('btn-stop-warmup') as HTMLButtonElement;
    const status = document.getElementById('warmup-status') as HTMLSpanElement;

    start.click();
    stop.click();

    expect(status.textContent).toBe('Warm-up stopped. You can start rehearsal.');
    expect(start.classList.contains('hidden')).toBe(false);
    expect(start.disabled).toBe(false);
    expect(stop.classList.contains('hidden')).toBe(true);
    expect(stop.disabled).toBe(true);
  });

  it('treats stop click as no-op when warm-up is not active', () => {
    const slot = document.getElementById('slot-pitch-overlay') as HTMLDivElement;
    pitchOverlayFeature.mount(slot);

    const stop = document.getElementById('btn-stop-warmup') as HTMLButtonElement;
    const status = document.getElementById('warmup-status') as HTMLSpanElement;

    // The stop button must remain disabled while idle — disabled buttons do not
    // fire native click events, so this is the actual no-op mechanism.
    expect(stop.disabled).toBe(true);
    expect(stop.classList.contains('hidden')).toBe(true);

    // Dispatch a programmatic click to verify the handler guard also ignores it.
    const before = status.textContent;
    stop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(status.textContent).toBe(before);
  });
});
