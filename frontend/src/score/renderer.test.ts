import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OsmdScoreRenderer, withSuppressedOsmdWarnings } from './renderer';

interface MockSheet {
  Transpose: number;
  TitleString: string;
  SubtitleString: string;
  ComposerString: string;
  LyricistString: string;
}

const mocks = vi.hoisted(() => ({
  renderMock: vi.fn(),
  loadMock: vi.fn(async (_file: Blob) => undefined),
  updateGraphicMock: vi.fn(),
  instances: [] as Array<{ Sheet: MockSheet }>,
  constructorOptions: [] as unknown[],
}));

vi.mock('opensheetmusicdisplay', () => ({
  OpenSheetMusicDisplay: class {
    Sheet: MockSheet = {
      Transpose: 0,
      TitleString: '',
      SubtitleString: '',
      ComposerString: '',
      LyricistString: '',
    };

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
  // Real OSMD's MXLFile, used by OsmdScoreRenderer's title-fallback (#698)
  // to recover raw MusicXML text independently of OSMD's own parsing. The
  // tests below feed plain (unzipped) XML blobs, so tryUnzip() always
  // "fails" here and callers fall back to file.text() — matching how the
  // real MXLFile behaves for a non-zip Blob.
  MXLFile: class {
    unzipSuccessful = false;
    constructor(_blob: Blob) {}
    async tryUnzip(): Promise<boolean> {
      return false;
    }
    async getXmlString(): Promise<string> {
      throw new Error('not a zip file');
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

/**
 * jsdom's Blob (used by vitest's jsdom test environment) doesn't implement
 * .text() — real browser Blobs do, so this is a test-environment gap, not a
 * production bug. Build a File-like object with a working .text() so the
 * fallback path under test (extractMusicXmlText -> file.text()) is
 * exercised the same way it would be in the browser.
 */
function fileWithXmlText(xml: string): File {
  const blob = new Blob([xml], { type: 'application/xml' });
  return Object.assign(blob, { text: async () => xml, name: 'score.xml' }) as File;
}

describe('OsmdScoreRenderer title fallback (#698)', () => {
  beforeEach(() => {
    mocks.renderMock.mockClear();
    mocks.loadMock.mockClear();
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

  it('promotes the largest-font credit as the OSMD title and clears the credit it was mislabeled under', async () => {
    // Mirrors musescore/homeward_bound.mxl: no work-title, both
    // credit-type="title" blocks unsized, real title mislabeled lyricist
    // but printed far larger than anything else on the page.
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words>with optional PianoTraX CD*</credit-words>
        </credit>
        <credit page="1">
          <credit-type>lyricist</credit-type>
          <credit-words font-size="23">HOMEWARD BOUND</credit-words>
        </credit>
      </score-partwise>`;
    const file = fileWithXmlText(xml);

    const renderer = new OsmdScoreRenderer(document.createElement('div'));
    // The renderer's own OSMD instance is a mock, so it never actually
    // parses credit-type="lyricist" into Sheet.LyricistString the way real
    // OSMD would. Seed it here to reproduce that starting state, so the
    // assertion below can verify the fallback pass clears it (rather than
    // trivially passing because it was already empty).
    mocks.instances[0].Sheet.LyricistString = 'HOMEWARD BOUND';
    await renderer.load(file);

    expect(mocks.instances[0].Sheet.TitleString).toBe('HOMEWARD BOUND');
    expect(mocks.instances[0].Sheet.LyricistString).toBe('');
  });

  it('leaves OSMD title resolution untouched when a <work-title> is present', async () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <work><work-title>Amazing Grace</work-title></work>
        <credit page="1">
          <credit-type>lyricist</credit-type>
          <credit-words font-size="40">SOME BIG TEXT</credit-words>
        </credit>
      </score-partwise>`;
    const file = fileWithXmlText(xml);

    const renderer = new OsmdScoreRenderer(document.createElement('div'));
    await renderer.load(file);

    expect(mocks.instances[0].Sheet.TitleString).toBe('');
    expect(mocks.instances[0].Sheet.LyricistString).toBe('');
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
