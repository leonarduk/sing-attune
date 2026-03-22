import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUNDFONT_URLS, SoundfontLoader } from './soundfont';

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
    for (let i = 0; i < SOUNDFONT_URLS.length - 1; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse('', { ok: false, status: 503 }));
    }
    fetchMock.mockResolvedValueOnce(mockResponse(
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
    ));
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader();
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(SOUNDFONT_URLS.length);
    for (const [idx, url] of SOUNDFONT_URLS.entries()) {
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

    const loader = new SoundfontLoader();
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mirror failed (html, 200)'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(SOUNDFONT_URLS[0]));
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

    const loader = new SoundfontLoader();
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

    const loader = new SoundfontLoader();

    await expect(loader.load(ctx)).rejects.toMatchObject({
      name: 'SoundfontLoadError',
      failures: expect.arrayContaining([
        expect.objectContaining({ type: 'html', url: SOUNDFONT_URLS[0], status: 200 }),
        expect.objectContaining({ type: 'parse', url: SOUNDFONT_URLS[1], status: 200 }),
        expect.objectContaining({ type: 'network', url: SOUNDFONT_URLS[2], status: null }),
        expect.objectContaining({ type: 'http', url: SOUNDFONT_URLS[3], status: 503 }),
        expect.objectContaining({ type: 'parse', url: SOUNDFONT_URLS[4], status: 200 }),
      ]),
    });
    expect(warnSpy).toHaveBeenCalledTimes(SOUNDFONT_URLS.length);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load soundfont from all mirrors'));
  });
});
