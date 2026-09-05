import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, getSession } from '../../services/score-session';
import { clearLoopRegion } from '../../services/loop-region';
import { type ScoreModel } from '../../score/renderer';

const setAppStatusMock = vi.fn();
const showErrorBannerMock = vi.fn();
const clearErrorBannerMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../../services/status', () => ({
  setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
}));

vi.mock('../../services/backend', () => ({
  showErrorBanner: (...args: unknown[]) => showErrorBannerMock(...args),
  clearErrorBanner: () => clearErrorBannerMock(),
}));

vi.mock('../../services/toast', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

// transport/controls re-exports beatToSeconds from playback/engine at import
// time; mocked wholesale here (it is unused by the reentrancy paths under
// test — click-to-seek is not exercised) so that mocking playback/engine
// below can't leave it importing a stale/undefined binding.
vi.mock('../../transport/controls', () => ({
  beatToMs: vi.fn(() => 0),
  seekPlayback: vi.fn(async () => ({ state: 'playing', t_ms: 0 })),
  postPlayback: vi.fn(async () => ({ state: 'idle', t_ms: 0 })),
}));

vi.mock('../../services/audio-context', () => ({
  getAudioContext: vi.fn(() => ({}) as unknown),
  getSoundfont: vi.fn(() => ({}) as unknown),
  ensureSoundfontLoaded: vi.fn(() => Promise.resolve()),
  getSoundfontLoadPromise: vi.fn(() => Promise.resolve()),
  getPlaybackTimbreMode: vi.fn(() => 'soundfont'),
  retrySoundfontLoad: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../playback/engine', () => {
  class FakePlaybackEngine {
    state = 'idle';
    tempoMultiplier = 1;
    constructor(_ctx: unknown, _sf: unknown) {
      void _ctx;
      void _sf;
    }
    setTransposeSemitones(): void {}
    schedule(): void {}
    stop(): void {}
    seekToBeat(): void {}
  }
  return { PlaybackEngine: FakePlaybackEngine };
});

// Renderer mock with controllable, per-call resolution — this is what lets
// the tests below reproduce "second load finishes before first load" (the
// last-to-resolve-vs-last-to-start race from #435) deterministically.
const rendererMocks = vi.hoisted(() => ({
  loadCalls: [] as Array<{
    file: File;
    resolve: (model: unknown) => void;
    reject: (err: unknown) => void;
  }>,
  constructedContainers: [] as HTMLElement[],
}));

vi.mock('../../score/renderer', () => {
  class FakeOsmdScoreRenderer {
    loaded = false;
    scoreModel: unknown = null;
    constructor(container: HTMLElement) {
      rendererMocks.constructedContainers.push(container);
    }

    load(file: File): Promise<unknown> {
      return new Promise((resolve, reject) => {
        rendererMocks.loadCalls.push({
          file,
          resolve: (model: unknown) => {
            this.scoreModel = model;
            this.loaded = true;
            resolve(model);
          },
          reject,
        });
      });
    }

    createCursor(): unknown {
      return {
        playing: false,
        play: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(),
        seekToBeat: vi.fn(),
        show: vi.fn(),
        getElement: () => null,
      };
    }

    getMeasureHitZones(): unknown[] {
      return [];
    }
    setHighlightedPart(): void {}
    applyVisualTranspose(): void {}
  }

  return { OsmdScoreRenderer: FakeOsmdScoreRenderer };
});

import { scoreLoaderFeature } from './index';

function installDom(): void {
  document.body.innerHTML = `
    <div id="slot-score-loader"></div>
    <div id="drop-zone"><p>Drop a score here</p></div>
    <input type="file" id="file-input" />
    <button id="btn-browse"></button>
    <div id="score-container"></div>
    <div id="score-info"></div>
    <div id="score-loading"></div>
    <select id="part-select"></select>
    <input type="checkbox" id="show-accompaniment" />
    <input type="range" id="tempo-slider" value="100" />
    <select id="transpose-select"><option value="0" selected>0</option></select>
    <div id="headphone-warning" class="hidden"></div>
    <button id="btn-play"></button>
    <button id="btn-pause"></button>
    <button id="btn-stop"></button>
    <button id="btn-rewind"></button>
  `;
}

function scoreModelFixture(title: string): ScoreModel {
  return {
    title,
    parts: ['Soprano', 'Alto'],
    notes: [],
    tempo_marks: [{ beat: 0, bpm: 120 }],
    time_signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    total_beats: 8,
  };
}

/** Drain pending microtask chains (soundfont await, promise continuations). */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('scoreLoaderFeature render surface (#649)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererMocks.loadCalls.length = 0;
    rendererMocks.constructedContainers.length = 0;
    installDom();
    clearSession();
    clearLoopRegion();
  });

  it('renders OSMD into a #score-surface child, not the scrolling #score-container itself', async () => {
    // Regression test for #649: OSMD sizes its SVG from its container's
    // offsetWidth, which does not exclude the width #score-container's own
    // scrollbar carves out of its content box. Rendering straight into
    // #score-container therefore clips right-justified title-page text
    // (composer/lyricist credits) by the scrollbar's width. The fix renders
    // into a plain, non-scrolling wrapper div instead, so its offsetWidth is
    // already scrollbar-correct.
    const slot = document.getElementById('slot-score-loader') as HTMLDivElement;
    scoreLoaderFeature.mount(slot);

    const input = document.getElementById('file-input') as HTMLInputElement;
    const file = new File(['<a/>'], 'test.xml', { type: 'application/vnd.recordare.musicxml+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const scoreContainerEl = document.getElementById('score-container') as HTMLDivElement;
    expect(rendererMocks.constructedContainers).toHaveLength(1);
    const renderTarget = rendererMocks.constructedContainers[0];

    expect(renderTarget).not.toBe(scoreContainerEl);
    expect(renderTarget.id).toBe('score-surface');
    expect(scoreContainerEl.contains(renderTarget)).toBe(true);
  });
});

describe('scoreLoaderFeature reentrancy guard (#435)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererMocks.loadCalls.length = 0;
    rendererMocks.constructedContainers.length = 0;
    installDom();
    clearSession();
    clearLoopRegion();
  });

  it('keeps the latest of two rapid score loads and discards the stale one', async () => {
    const slot = document.getElementById('slot-score-loader') as HTMLDivElement;
    scoreLoaderFeature.mount(slot);

    const input = document.getElementById('file-input') as HTMLInputElement;
    const fileFirst = new File(['<a/>'], 'first.xml', { type: 'application/vnd.recordare.musicxml+xml' });
    const fileSecond = new File(['<b/>'], 'second.xml', { type: 'application/vnd.recordare.musicxml+xml' });

    // First file drops and its (slow) parse is in flight...
    Object.defineProperty(input, 'files', { value: [fileFirst], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(rendererMocks.loadCalls).toHaveLength(1);

    // ...then, while it's still unresolved, a second file is dropped. This
    // is the exact scenario from #435: "dropping a second file while a slow
    // parse is in flight".
    Object.defineProperty(input, 'files', { value: [fileSecond], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    expect(rendererMocks.loadCalls).toHaveLength(2);
    expect(rendererMocks.loadCalls[0].file).toBe(fileFirst);
    expect(rendererMocks.loadCalls[1].file).toBe(fileSecond);

    // Resolve the *second* (latest-started) load first — reproduces the
    // exact "last-to-resolve wins, not last-to-start" bug from #435.
    rendererMocks.loadCalls[1].resolve(scoreModelFixture('Second'));
    await flushMicrotasks();

    expect(getSession()?.model.title).toBe('Second');

    // The stale first load resolves late — it must not clobber state.
    rendererMocks.loadCalls[0].resolve(scoreModelFixture('First'));
    await flushMicrotasks();

    const session = getSession();
    expect(session?.model.title).toBe('Second');
    expect(document.getElementById('score-info')?.textContent).toContain('Second');
    expect(document.getElementById('score-info')?.textContent).not.toContain('First');
    expect((document.getElementById('file-input') as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById('btn-browse') as HTMLButtonElement).disabled).toBe(false);
    expect(setAppStatusMock).toHaveBeenLastCalledWith('score loaded', 'success');
  });

  it('abandons an in-flight load immediately when a newer one starts before it even reaches the renderer', async () => {
    // Two loads triggered back-to-back in the same tick (e.g. a double
    // click/drop) is an even narrower race than the "slow parse in flight"
    // case above: the stale call should bail out at the teardown checkpoint
    // and never touch the (shared, DOM-mutating) renderer/container at all.
    const slot = document.getElementById('slot-score-loader') as HTMLDivElement;
    scoreLoaderFeature.mount(slot);

    const input = document.getElementById('file-input') as HTMLInputElement;
    const fileFirst = new File(['<a/>'], 'first.xml', { type: 'application/vnd.recordare.musicxml+xml' });
    const fileSecond = new File(['<b/>'], 'second.xml', { type: 'application/vnd.recordare.musicxml+xml' });

    Object.defineProperty(input, 'files', { value: [fileFirst], configurable: true });
    input.dispatchEvent(new Event('change'));
    Object.defineProperty(input, 'files', { value: [fileSecond], configurable: true });
    input.dispatchEvent(new Event('change'));

    await flushMicrotasks();

    expect(rendererMocks.loadCalls).toHaveLength(1);
    expect(rendererMocks.loadCalls[0].file).toBe(fileSecond);

    rendererMocks.loadCalls[0].resolve(scoreModelFixture('Second'));
    await flushMicrotasks();

    expect(getSession()?.model.title).toBe('Second');
    expect((document.getElementById('file-input') as HTMLInputElement).disabled).toBe(false);
  });

  it('disables the file input and browse button while a load is in flight, and re-enables them once it settles', async () => {
    const slot = document.getElementById('slot-score-loader') as HTMLDivElement;
    scoreLoaderFeature.mount(slot);

    const input = document.getElementById('file-input') as HTMLInputElement;
    const browseBtn = document.getElementById('btn-browse') as HTMLButtonElement;
    const file = new File(['<a/>'], 'first.xml', { type: 'application/vnd.recordare.musicxml+xml' });

    expect(input.disabled).toBe(false);
    expect(browseBtn.disabled).toBe(false);

    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    expect(rendererMocks.loadCalls).toHaveLength(1);
    expect(input.disabled).toBe(true);
    expect(browseBtn.disabled).toBe(true);

    rendererMocks.loadCalls[0].resolve(scoreModelFixture('Only'));
    await flushMicrotasks();

    expect(input.disabled).toBe(false);
    expect(browseBtn.disabled).toBe(false);
  });

  it('swallows a stale load that fails after being superseded, without banner-stomping the newer session', async () => {
    const slot = document.getElementById('slot-score-loader') as HTMLDivElement;
    scoreLoaderFeature.mount(slot);

    const input = document.getElementById('file-input') as HTMLInputElement;
    const fileFirst = new File(['<a/>'], 'first.xml', { type: 'application/vnd.recordare.musicxml+xml' });
    const fileSecond = new File(['<b/>'], 'second.xml', { type: 'application/vnd.recordare.musicxml+xml' });

    Object.defineProperty(input, 'files', { value: [fileFirst], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    Object.defineProperty(input, 'files', { value: [fileSecond], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    expect(rendererMocks.loadCalls).toHaveLength(2);

    rendererMocks.loadCalls[1].resolve(scoreModelFixture('Second'));
    await flushMicrotasks();
    expect(getSession()?.model.title).toBe('Second');

    showErrorBannerMock.mockClear();

    // The stale first load fails late (e.g. a slow backend parse erroring
    // out) — it must be swallowed, not surfaced over the newer session.
    rendererMocks.loadCalls[0].reject(new Error('backend parse failed'));
    await flushMicrotasks();

    expect(showErrorBannerMock).not.toHaveBeenCalled();
    expect(getSession()?.model.title).toBe('Second');
  });
});
