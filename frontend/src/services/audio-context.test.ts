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

  it('a stale in-flight load does not clobber timbre mode set by a newer voice switch (#361 review fix)', async () => {
    // Regression test for the race: ensureSoundfontLoaded() used to attach its
    // .then()/.catch() unconditionally, so an old load that was still in
    // flight when the user switched voices could settle *after* the new
    // voice's outcome and overwrite playbackTimbreMode with its own result.
    class StubAudioContext {}
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);

    const { SoundfontLoader } = await import('../playback/soundfont');

    let resolveSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => { resolveSlow = resolve; });

    vi.spyOn(SoundfontLoader.prototype, 'load')
      .mockImplementationOnce(() => slow) // choir_aahs: slow, eventually resolves OK
      .mockImplementationOnce(() => Promise.reject(new Error('offline'))); // voice_oohs: fails fast

    const audioContext = await import('./audio-context');

    void audioContext.ensureSoundfontLoaded(); // load A in flight (choir_aahs)
    await audioContext.setPlaybackInstrument('voice_oohs'); // user switches mid-load; B fails fast

    expect(audioContext.getPlaybackTimbreMode()).toBe('synth-fallback');

    resolveSlow(); // the stale load A finally settles
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Without the generation guard this regresses to 'soundfont', even though
    // the currently-selected instrument (voice_oohs) has zero decoded buffers.
    expect(audioContext.getPlaybackTimbreMode()).toBe('synth-fallback');
  });
});
