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
  });
});
