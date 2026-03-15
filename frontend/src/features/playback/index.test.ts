import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAppStatusMock = vi.fn();
const getSessionMock = vi.fn(() => null);

vi.mock('../../services/score-session', () => ({
  getSession: () => getSessionMock(),
  onScoreLoaded: () => () => {},
  onScoreCleared: () => () => {},
  onPartChanged: () => () => {},
}));

vi.mock('../../services/status', () => ({
  setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
}));

vi.mock('../../services/cursor-projection', () => ({
  recordBeatSample: () => {},
  resetProjection: () => {},
  getCursorX: () => 0,
}));

vi.mock('../../services/progress-history', () => ({
  finishPracticeSessionCapture: () => {},
  startPracticeSessionCapture: () => {},
}));

vi.mock('../../services/playback-sync', () => ({
  emitPlaybackSyncEvent: () => {},
}));

vi.mock('../../transport/controls', () => ({
  beatToMs: () => 0,
  postPlayback: vi.fn(async () => ({ t_ms: 0 })),
  setPlaybackTempo: vi.fn(async () => ({})),
  startPlayback: vi.fn(async () => ({ t_ms: 0 })),
  seekPlayback: vi.fn(async () => ({ t_ms: 0 })),
}));

vi.mock('../../practice/session-summary', () => ({
  sessionSummaryTracker: {
    recordSample: () => {},
    finishSession: () => null,
    reset: () => {},
  },
}));

vi.mock('../../services/audio-preflight', () => ({
  ensureAudioPreflightReady: vi.fn(async () => true),
}));

vi.mock('../../services/loop-region', () => ({
  clearLoopRegion: () => {},
  getLoopRegion: () => ({ active: false, startBeat: 0, endBeat: 0 }),
  setLoopEnd: () => {},
  setLoopStart: () => {},
}));

vi.mock('../../media-session', () => ({
  installMediaSession: () => {},
  updateMediaSessionMetadata: () => {},
  updateMediaSessionState: () => {},
}));

import { playbackFeature } from './index';

function installPlaybackDom(): void {
  document.body.innerHTML = `
    <div id="slot-playback"></div>
    <button id="btn-play">Play</button>
    <button id="btn-pause">Pause</button>
    <button id="btn-stop">Stop</button>
    <button id="btn-rewind">Rewind</button>
    <div id="headphone-warning" class="hidden"></div>
    <button id="warning-dismiss">Dismiss</button>
    <button id="btn-summary-close">Close</button>
    <button id="btn-summary-retry">Retry</button>
    <button id="btn-summary-replay">Replay</button>
    <div id="session-summary-modal" class="hidden"></div>
    <pre id="session-summary-content"></pre>
    <input id="tempo-slider" value="100" />
    <span id="tempo-label">100%</span>
    <select id="settings-device"><option value=""></option></select>
  `;
}

describe('playbackFeature', () => {
  beforeEach(() => {
    setAppStatusMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockReturnValue(null);
    installPlaybackDom();
  });

  it('disables play on mount when no score session exists', () => {
    const slot = document.getElementById('slot-playback') as HTMLDivElement;
    playbackFeature.mount(slot);

    const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
    expect(btnPlay.disabled).toBe(true);

    // unmount is always provided by playbackFeature even though the Feature
    // interface marks it optional; use non-null assertion to satisfy tsc.
    playbackFeature.unmount!();
  });

  it('shows a status message when play is triggered without a score session', () => {
    const slot = document.getElementById('slot-playback') as HTMLDivElement;
    playbackFeature.mount(slot);

    const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
    btnPlay.disabled = false;
    btnPlay.click();

    expect(setAppStatusMock).toHaveBeenCalledWith('Load a score first', 'warning');

    playbackFeature.unmount!();
  });
});
