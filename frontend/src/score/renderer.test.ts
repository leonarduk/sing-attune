import { describe, it, expect, vi } from 'vitest';
import { withSuppressedOsmdWarnings } from './renderer';

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
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  renderMock: vi.fn(),
  loadMock: vi.fn(async (_file: Blob) => undefined),
  updateGraphicMock: vi.fn(),
}));

vi.mock('opensheetmusicdisplay', () => ({
  OpenSheetMusicDisplay: class {
    Sheet = { Transpose: 0 };

    constructor(_container: HTMLElement, _options: unknown) {}

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

import { ScoreRenderer } from './renderer';

describe('ScoreRenderer visual transpose', () => {
  beforeEach(() => {
    mocks.renderMock.mockClear();
    mocks.loadMock.mockClear();
    mocks.updateGraphicMock.mockClear();

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
    const renderer = new ScoreRenderer({} as HTMLElement);
    await renderer.load(new Blob(['<score-partwise/>'], { type: 'application/xml' }) as File);

    expect(mocks.renderMock).toHaveBeenCalledTimes(1);

    renderer.applyVisualTranspose(3);

    expect(renderer.osmd.Sheet.Transpose).toBe(3);
    expect(mocks.updateGraphicMock).toHaveBeenCalledTimes(1);
    expect(mocks.renderMock).toHaveBeenCalledTimes(2);
  });

  it('stores transpose before load and applies it once rendered', async () => {
    const renderer = new ScoreRenderer({} as HTMLElement);
    renderer.applyVisualTranspose(-5);

    expect(mocks.updateGraphicMock).not.toHaveBeenCalled();

    await renderer.load(new Blob(['<score-partwise/>'], { type: 'application/xml' }) as File);

    expect(renderer.osmd.Sheet.Transpose).toBe(-5);
    expect(mocks.updateGraphicMock).toHaveBeenCalledTimes(1);
    expect(mocks.renderMock).toHaveBeenCalledTimes(2);
  });
});
