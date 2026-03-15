import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundfontLoader } from './soundfont';

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

  it('throws when no soundfont assignment is present', () => {
    expect(() => SoundfontLoader.parseNoteMap('<!doctype html>403 Forbidden')).toThrow(
      'Could not parse soundfont JS: no JSON object found',
    );
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
