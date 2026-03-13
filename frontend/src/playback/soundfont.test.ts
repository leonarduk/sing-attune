import { describe, expect, it } from 'vitest';
import { SoundfontLoader } from './soundfont';

describe('SoundfontLoader.parseNoteMap', () => {
  it('parses MIDI.js assignment with trailing non-JSON content', () => {
    const js = [
      'MIDI.Soundfont.acoustic_grand_piano = {"A0":"data:audio/mp3;base64,QQ=="};',
      '//# sourceMappingURL=acoustic_grand_piano.js.map',
    ].join('\n');

    expect(SoundfontLoader.parseNoteMap(js)).toEqual({
      A0: 'data:audio/mp3;base64,QQ==',
    });
  });

  it('throws when no soundfont assignment is present', () => {
    expect(() => SoundfontLoader.parseNoteMap('<!doctype html>403 Forbidden')).toThrow(
      'Could not parse soundfont JS: no JSON object found',
    );
  });
});
