import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('audio-context soundfont fallback mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('switches to synth-fallback when soundfont load fails', async () => {
    // A class (not an arrow function) so `new AudioContext()` works under jsdom/vitest.
    class StubAudioContext {}
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);

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

  it('allows retrying soundfont load after an initial failure', async () => {
    // A class (not an arrow function) so `new AudioContext()` works under jsdom/vitest.
    class StubAudioContext {}
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);

    const { SoundfontLoader } = await import('../playback/soundfont');
    const loadSpy = vi.spyOn(SoundfontLoader.prototype, 'load')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);

    const audioContext = await import('./audio-context');

    await audioContext.ensureSoundfontLoaded();
    expect(audioContext.getPlaybackTimbreMode()).toBe('synth-fallback');

    await audioContext.retrySoundfontLoad();
    expect(audioContext.getPlaybackTimbreMode()).toBe('soundfont');
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it('constructs the shared soundfont using the persisted playback voice (#361)', async () => {
    localStorage.setItem('sing-attune.preflight.playbackVoice', 'voice_oohs');

    // A class (not an arrow function) so `new AudioContext()` works under jsdom/vitest.
    class StubAudioContext {}
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);

    const { SoundfontLoader } = await import('../playback/soundfont');
    vi.spyOn(SoundfontLoader.prototype, 'load').mockResolvedValue(undefined);

    const audioContext = await import('./audio-context');
    expect(audioContext.getSoundfont().instrumentId).toBe('voice_oohs');

    localStorage.removeItem('sing-attune.preflight.playbackVoice');
  });

  it('setPlaybackInstrument swaps the loader and reloads without throwing on failure', async () => {
    // A class (not an arrow function) so `new AudioContext()` works under jsdom/vitest.
    class StubAudioContext {}
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);

    const { SoundfontLoader } = await import('../playback/soundfont');
    vi.spyOn(SoundfontLoader.prototype, 'load')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('choir_aahs offline'));

    const audioContext = await import('./audio-context');
    await audioContext.setPlaybackInstrument('choir_aahs');
    expect(audioContext.getSoundfont().instrumentId).toBe('choir_aahs');
    expect(audioContext.getPlaybackTimbreMode()).toBe('soundfont');

    await audioContext.setPlaybackInstrument('voice_oohs');
    expect(audioContext.getSoundfont().instrumentId).toBe('voice_oohs');
    expect(audioContext.getPlaybackTimbreMode()).toBe('synth-fallback');
  });
});
