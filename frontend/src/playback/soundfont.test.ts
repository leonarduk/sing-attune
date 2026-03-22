import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUNDFONT_URLS, SoundfontLoader } from './soundfont';

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


  it('parses soundfont objects with a trailing comma before the closing brace', () => {
    const js = 'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ==",}';

    expect(SoundfontLoader.parseNoteMap(js)).toEqual({
      A0: 'data:audio/mp3;base64,QQ==',
    });
  });

  it('throws a helpful error when a mirror returns HTML', () => {
    expect(() => SoundfontLoader.parseNoteMap('<!doctype html>403 Forbidden')).toThrow(
      'Could not parse soundfont JS: received HTML instead of soundfont data',
    );
  });

  it('tries mirrors in declared priority order', async () => {
    const fetchMock = vi.fn();
    for (let i = 0; i < SOUNDFONT_URLS.length - 1; i++) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => '',
      });
    }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
    });
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

  it('throws after exhausting every mirror', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'MIDI.Soundfont.acoustic_grand_piano = {invalid};',
    });
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader();

    await expect(loader.load(ctx)).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(SOUNDFONT_URLS.length);
  });
  it('retries a secondary mirror when the first mirror has corrupt JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'MIDI.Soundfont.acoustic_grand_piano = {invalid};',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
      });
    vi.stubGlobal('fetch', fetchMock);

    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const loader = new SoundfontLoader();
    await loader.load(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.any(String), { cache: 'no-store' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(String), { cache: 'no-store' });
    expect(loader.loaded).toBe(true);
    expect(loader.sampleCount).toBe(1);
  });
});
