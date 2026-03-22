import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScoreSession } from '../../services/score-session';

const getSessionMock = vi.fn<[], ScoreSession | null>(() => null);
const onScoreLoadedHandlers: Array<() => void> = [];
const onScoreClearedHandlers: Array<() => void> = [];

vi.mock('../../services/score-session', () => ({
  getSession: () => getSessionMock(),
  updateSelectedPart: () => {},
  onScoreLoaded: (cb: () => void) => {
    onScoreLoadedHandlers.push(cb);
    return () => {};
  },
  onScoreCleared: (cb: () => void) => {
    onScoreClearedHandlers.push(cb);
    return () => {};
  },
}));

vi.mock('../../services/status', () => ({
  setAppStatus: () => {},
}));

vi.mock('../../part-options', () => ({
  getVisiblePartOptions: (parts: string[]) => parts.map((name) => ({ name })),
}));

vi.mock('../../transport/controls', () => ({
  setPlaybackTranspose: vi.fn(async () => ({})),
}));

vi.mock('../../services/tempo', () => ({
  applyTempoChange: vi.fn(async () => ({})),
}));

import { partSelectorFeature } from './index';

function installDom(): void {
  document.body.innerHTML = `
    <div id="slot-part-selector"></div>
    <label for="part-select">Part:</label>
    <select id="part-select"></select>
    <label class="checkbox-label" for="show-accompaniment">
      <input id="show-accompaniment" type="checkbox" />
      Show all parts
    </label>
    <details id="playback-options-panel">
      <summary>Playback options</summary>
      <div>
        <label for="transpose-select">Transpose:</label>
        <select id="transpose-select"><option value="0" selected>0</option></select>
        <div class="tempo-group">
          <label for="tempo-slider">Tempo:</label>
          <input id="tempo-slider" value="100" />
          <span id="tempo-label">100%</span>
        </div>
      </div>
    </details>
  `;
}

describe('partSelectorFeature', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getSessionMock.mockReset();
    getSessionMock.mockReturnValue(null);
    onScoreLoadedHandlers.length = 0;
    onScoreClearedHandlers.length = 0;
    installDom();
  });

  it('keeps playback options collapsed by default when no score is loaded', () => {
    const slot = document.getElementById('slot-part-selector') as HTMLDivElement;
    partSelectorFeature.mount(slot);

    const panel = document.getElementById('playback-options-panel') as HTMLDetailsElement;
    expect(panel.open).toBe(false);
  });

  it('auto-expands playback options when a score becomes active and collapses again when cleared', () => {
    const slot = document.getElementById('slot-part-selector') as HTMLDivElement;
    partSelectorFeature.mount(slot);

    const panel = document.getElementById('playback-options-panel') as HTMLDetailsElement;
    expect(onScoreLoadedHandlers).toHaveLength(1);
    expect(onScoreClearedHandlers).toHaveLength(1);

    getSessionMock.mockReturnValue({
      selectedPart: 'Soprano',
      model: {
        parts: ['Soprano'],
        notes: [{ part: 'Soprano' }],
        tempo_marks: [],
      },
      engine: {
        state: 'idle',
        schedule: () => {},
        setTransposeSemitones: () => {},
      },
      renderer: {
        setHighlightedPart: () => {},
      },
    } as unknown as ScoreSession);

    onScoreLoadedHandlers[0]();
    expect(panel.open).toBe(true);

    onScoreClearedHandlers[0]();
    expect(panel.open).toBe(false);
  });

  it('keeps the Show all parts checkbox outside the playback options panel', () => {
    const showAllParts = document.getElementById('show-accompaniment') as HTMLInputElement;
    const panel = document.getElementById('playback-options-panel') as HTMLDetailsElement;

    expect(panel.contains(showAllParts)).toBe(false);
  });
});
