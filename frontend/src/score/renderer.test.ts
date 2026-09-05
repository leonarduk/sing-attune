import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OsmdScoreRenderer, withSuppressedOsmdWarnings } from './renderer';

const mocks = vi.hoisted(() => ({
  renderMock: vi.fn(),
  loadMock: vi.fn(async (_file: Blob) => undefined),
  updateGraphicMock: vi.fn(),
  instances: [] as Array<{ Sheet: { Transpose: number } }>,
  constructorOptions: [] as unknown[],
}));

vi.mock('opensheetmusicdisplay', () => ({
  OpenSheetMusicDisplay: class {
    Sheet = { Transpose: 0 };

    constructor(_container: HTMLElement, options: unknown) {
      mocks.instances.push(this);
      mocks.constructorOptions.push(options);
    }

    async load(file: Blob): Promise<void> {
      await mocks.loadMock(file);
    }

    updateGraphic(): void {
      mocks.updateGraphicMock();
    }

    render(): void {
      mocks.renderMock();
    }
  },
}));

describe('withSuppressedOsmdWarnings', () => {
  it('suppresses only the known OSMD SkyBottomLine warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await withSuppressedOsmdWarnings(async () => {
      console.warn('Not enough lines for SkyBottomLine calculation');
      console.warn('different warning', { foo: 'bar' });
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('different warning', { foo: 'bar' });
  });

  it('restores console.warn even when callback throws', async () => {
    const originalWarn = console.warn;

    await expect(
      withSuppressedOsmdWarnings(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(console.warn).toBe(originalWarn);
  });
});

describe('OsmdScoreRenderer title-page credits (#649)', () => {
  beforeEach(() => {
    mocks.constructorOptions.length = 0;
  });

  it('re-enables drawCredits so compacttight mode does not hide subtitle/composer/lyricist', () => {
    // Regression test for #649: OSMD's `drawingParameters: 'compacttight'`
    // internally sets DrawCredits=false, which silences Subtitle/Composer/
    // Lyricist rendering (only Title survived, because it was re-enabled
    // separately). `drawCredits: true` is applied by OSMD *after* the
    // drawingParameters preset, so it must be present to restore the full
    // title-page credit block for scores like musescore/homeward_bound.mxl.
    new OsmdScoreRenderer(document.createElement('div'));

    expect(mocks.constructorOptions).toHaveLength(1);
    const options = mocks.constructorOptions[0] as Record<string, unknown>;
    expect(options.drawCredits).toBe(true);
    expect(options.drawingParameters).toBe('compacttight');
  });
});

describe('ScoreRenderer visual transpose', () => {
  beforeEach(() => {
    mocks.renderMock.mockClear();
    mocks.loadMock.mockClear();
    mocks.updateGraphicMock.mockClear();
    mocks.instances.length = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          title: 'Test',
          parts: ['PART I'],
          notes: [],
          tempo_marks: [{ beat: 0, bpm: 120 }],
          time_signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
          total_beats: 1,
        }),
      })),
    );
  });

  it('re-renders notation when transposition changes after load', async () => {
    const renderer = new OsmdScoreRenderer({} as HTMLElement);
    await renderer.load(new Blob(['<score-partwise/>'], { type: 'application/xml' }) as File);

    expect(mocks.renderMock).toHaveBeenCalledTimes(1);

    renderer.applyVisualTranspose(3);

    expect(mocks.instances[0].Sheet.Transpose).toBe(3);
    expect(mocks.updateGraphicMock).toHaveBeenCalledTimes(1);
    expect(mocks.renderMock).toHaveBeenCalledTimes(2);
  });

  it('stores transpose before load and applies it once rendered', async () => {
    const renderer = new OsmdScoreRenderer({} as HTMLElement);
    renderer.applyVisualTranspose(-5);

    expect(mocks.updateGraphicMock).not.toHaveBeenCalled();

    await renderer.load(new Blob(['<score-partwise/>'], { type: 'application/xml' }) as File);

    expect(mocks.instances[0].Sheet.Transpose).toBe(-5);
    expect(mocks.updateGraphicMock).toHaveBeenCalledTimes(1);
    expect(mocks.renderMock).toHaveBeenCalledTimes(2);
  });
});

describe('ScoreRenderer reentrancy guard (#435)', () => {
  beforeEach(() => {
    mocks.renderMock.mockClear();
    mocks.loadMock.mockClear();
    mocks.updateGraphicMock.mockClear();
    mocks.instances.length = 0;
  });

  function scoreModelJson(title: string) {
    return {
      title,
      parts: ['PART I'],
      notes: [],
      tempo_marks: [{ beat: 0, bpm: 120 }],
      time_signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
      total_beats: 4,
    };
  }

  it('rejects a stale load() that resolves after a newer load() has started, without touching OSMD', async () => {
    // First call's backend fetch is held open deliberately; the second
    // call's resolves immediately — reproducing "last to start" (second)
    // finishing before "first to start" (first), the scenario #435 broke.
    let resolveFirstFetch!: (value: unknown) => void;
    const firstFetchPromise = new Promise((resolve) => {
      resolveFirstFetch = resolve;
    });

    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstFetchPromise)
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => scoreModelJson('Second'),
      }));
    vi.stubGlobal('fetch', fetchMock);

    const renderer = new OsmdScoreRenderer({} as HTMLElement);
    const fileA = new Blob(['<a/>'], { type: 'application/xml' }) as File;
    const fileB = new Blob(['<b/>'], { type: 'application/xml' }) as File;

    const loadA = renderer.load(fileA); // starts first, blocks on fetch
    const loadB = renderer.load(fileB); // starts second — supersedes A

    await loadB;
    expect(renderer.scoreModel?.title).toBe('Second');
    expect(renderer.loaded).toBe(true);

    // Now let A's stale fetch resolve. It must reject rather than clobber
    // the state B already committed, and it must never reach osmd.load() —
    // otherwise A's stale render could land on screen after B's.
    resolveFirstFetch({ ok: true, json: async () => scoreModelJson('First') });
    await expect(loadA).rejects.toThrow(/superseded/i);

    expect(renderer.scoreModel?.title).toBe('Second');
    expect(renderer.loaded).toBe(true);
    expect(mocks.loadMock).toHaveBeenCalledTimes(1);
    expect(mocks.loadMock).toHaveBeenCalledWith(fileB);
    expect(mocks.renderMock).toHaveBeenCalledTimes(1);
  });
});
