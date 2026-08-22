import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLAYBACK_INSTRUMENT_ID,
  FALLBACK_PLAYBACK_INSTRUMENT_ID,
  buildSoundfontUrls,
  SoundfontLoader,
} from './soundfont';

// Piano is used as the instrument id in most tests below so assertions can
// reuse the pre-#361 fixture bodies (which assign MIDI.Soundfont.acoustic_grand_piano).
const PIANO_URLS = buildSoundfontUrls(FALLBACK_PLAYBACK_INSTRUMENT_ID);

function mockResponse(body: string, init?: { ok?: boolean; status?: number; headers?: Record<string, string> }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: {
      get(name: string) {
        return init?.headers?.[name.toLowerCase()] ?? init?.headers?.[name] ?? null;
      },
    },
    text: async () => body,
  };
}

describe('SoundfontLoader.parseNoteMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses MIDI.js assignment with trailing non-JSON content', () => {
    const js = [
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
      '//# sourceMappingURL=acoustic_grand_piano.js.map',
    ].join('\n');

    expect(SoundfontLoader.parseNoteMap(js)).toEqual({
      A0: 'data:audio/mp3;base64,QQ==',
    });
  });

  it('parses when sample payload contains braces before object end', () => {
    const js = 'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ==","A1":"value}still-string"};';

    expect(SoundfontLoader.parseNoteMap(js)).toEqual({
      A0: 'data:audio/mp3;base64,QQ==',
      A1: 'value}still-string',
    });
  });

  it('handles a trailing comma before the closing brace with minimal sanitization', () => {
    const js = 'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ==",}';

    expect(SoundfontLoader.parseNoteMap(js)).toEqual({
      A0: 'data:audio/mp3;base64,QQ==',
    });
  });

  it('rejects HTML payloads before parsing', () => {
    expect(() => SoundfontLoader.parseNoteMap('<!doctype html>403 Forbidden')).toThrow(
      'Could not parse soundfont JS: received HTML instead of soundfont data',
    );
  });

  it('rejects truncated payloads deterministically', () => {
    expect(() => SoundfontLoader.parseNoteMap(
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="',
    )).toThrow('Could not parse soundfont JS: truncated JSON object');
  });

  it('rejects malformed JSON with a helpful parse error', () => {
    expect(() => SoundfontLoader.parseNoteMap(
      'MIDI.Soundfont.acoustic_grand_piano = {invalid};',
    )).toThrow('Could not parse soundfont JS: invalid JSON');
  });

  it('tries mirrors in declared priority order', async () => {
    const fetchMock = vi.fn();
    for (let i = 0; i < PIANO_URLS.length - 1; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse('', { ok: false, status: 503 }));
    }
    fetchMock.mockResolvedValueOnce(mockResponse(
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
    ));
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader(FALLBACK_PLAYBACK_INSTRUMENT_ID);
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(PIANO_URLS.length);
    for (const [idx, url] of PIANO_URLS.entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(idx + 1, url, { cache: 'no-store' });
    }
    expect(loader.loaded).toBe(true);
  });

  it('logs HTML mirror failures before JSON parsing and falls back to a healthy mirror', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse('<html>denied</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))
      .mockResolvedValueOnce(mockResponse(
        'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
      ));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader(FALLBACK_PLAYBACK_INSTRUMENT_ID);
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mirror failed (html, 200)'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(PIANO_URLS[0]));
    expect(loader.loaded).toBe(true);
  });

  it('retries a secondary mirror when the first mirror has corrupt JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse('MIDI.Soundfont.acoustic_grand_piano = {invalid};'))
      .mockResolvedValueOnce(mockResponse(
        'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
      ));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader(FALLBACK_PLAYBACK_INSTRUMENT_ID);
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mirror failed (parse, 200)'));
    expect(loader.loaded).toBe(true);
    expect(loader.sampleCount).toBe(1);
  });

  it('throws a single aggregated error after exhausting every mirror', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse('<html>bad gateway</html>', {
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(mockResponse('MIDI.Soundfont.acoustic_grand_piano = {"A0":"x"', {
        status: 200,
      }))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(mockResponse('', { ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse('MIDI.Soundfont.acoustic_grand_piano = {invalid};'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader(FALLBACK_PLAYBACK_INSTRUMENT_ID);

    await expect(loader.load(ctx)).rejects.toMatchObject({
      name: 'SoundfontLoadError',
      failures: expect.arrayContaining([
        expect.objectContaining({ type: 'html', url: PIANO_URLS[0], status: 200 }),
        expect.objectContaining({ type: 'parse', url: PIANO_URLS[1], status: 200 }),
        expect.objectContaining({ type: 'network', url: PIANO_URLS[2], status: null }),
        expect.objectContaining({ type: 'http', url: PIANO_URLS[3], status: 503 }),
        expect.objectContaining({ type: 'parse', url: PIANO_URLS[4], status: 200 }),
      ]),
    });
    expect(warnSpy).toHaveBeenCalledTimes(PIANO_URLS.length);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load soundfont from all mirrors'));
  });
});

// #361: instrument is a parameter, not a hardcoded piano URL constant.
describe('buildSoundfontUrls', () => {
  it('builds the bundled-first-then-CDN mirror list for the given instrument id', () => {
    expect(buildSoundfontUrls('choir_aahs')).toEqual([
      '/soundfonts/FluidR3_GM/choir_aahs-mp3.js',
      'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/choir_aahs-mp3.js',
      'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/choir_aahs-mp3.js',
      'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/choir_aahs-mp3.js',
      'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/FluidR3_GM/choir_aahs-mp3.js',
    ]);
  });

  it('builds a distinct mirror list per instrument id (no hardcoded instrument name)', () => {
    expect(buildSoundfontUrls('voice_oohs')[0]).toBe('/soundfonts/FluidR3_GM/voice_oohs-mp3.js');
    expect(buildSoundfontUrls('acoustic_grand_piano')[0]).toBe('/soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js');
  });

  it('defaults SoundfontLoader to a vocal timbre, not piano', () => {
    expect(new SoundfontLoader().instrumentId).toBe(DEFAULT_PLAYBACK_INSTRUMENT_ID);
    expect(DEFAULT_PLAYBACK_INSTRUMENT_ID).not.toBe(FALLBACK_PLAYBACK_INSTRUMENT_ID);
  });
});

describe('SoundfontLoader instrument fallback chain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to piano when the selected instrument fails on every mirror, without throwing', async () => {
    const choirUrls = buildSoundfontUrls('choir_aahs');
    const fetchMock = vi.fn();
    // Every choir_aahs mirror fails...
    for (let i = 0; i < choirUrls.length; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse('', { ok: false, status: 503 }));
    }
    // ...then the piano fallback succeeds on its first (bundled) mirror.
    fetchMock.mockResolvedValueOnce(mockResponse(
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
    ));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader('choir_aahs');
    await expect(loader.load(ctx)).resolves.toBeUndefined();

    expect(loader.loaded).toBe(true);
    expect(loader.sampleCount).toBe(1);
    // 5 failed choir_aahs mirrors + 1 successful piano mirror.
    expect(fetchMock).toHaveBeenCalledTimes(choirUrls.length + 1);
    expect(fetchMock).toHaveBeenNthCalledWith(choirUrls.length + 1, PIANO_URLS[0], { cache: 'no-store' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('instrument "choir_aahs" failed on every mirror, falling back to "acoustic_grand_piano"'),
    );
  });

  it('does not retry piano again when piano itself is the instrument that exhausted every mirror', async () => {
    const fetchMock = vi.fn();
    for (let i = 0; i < PIANO_URLS.length; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse('', { ok: false, status: 503 }));
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader(FALLBACK_PLAYBACK_INSTRUMENT_ID);
    await expect(loader.load(ctx)).rejects.toThrow('Failed to load soundfont from all mirrors');
    // Exactly one pass through the piano mirrors — no infinite/duplicate retry.
    expect(fetchMock).toHaveBeenCalledTimes(PIANO_URLS.length);
  });
});
