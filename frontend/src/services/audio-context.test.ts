import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('audio-context soundfont fallback mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('switches to synth-fallback when soundfont load fails', async () => {
    const audioContextStub = {} as AudioContext;
    vi.stubGlobal('AudioContext', vi.fn(() => audioContextStub));

    const { SoundfontLoader } = await import('../playback/soundfont');
    vi.spyOn(SoundfontLoader.prototype, 'load').mockRejectedValueOnce(new Error('offline'));

    const audioContext = await import('./audio-context');
    const listener = vi.fn();
    audioContext.onPlaybackTimbreModeChange(listener);

    await audioContext.ensureSoundfontLoaded();

    expect(audioContext.getPlaybackTimbreMode()).toBe('synth-fallback');
    expect(listener).toHaveBeenCalledWith('loading');
    expect(listener).toHaveBeenCalledWith('synth-fallback');
  });
});
