import { describe, expect, it } from 'vitest';

import { parseMusicXmlSummary } from './transcription-api';

const SAMPLE_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths></key>
      </attributes>
      <direction>
        <direction-type>
          <metronome><per-minute>96</per-minute></metronome>
        </direction-type>
      </direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>2</duration>
      </note>
      <note>
        <pitch><step>D</step><alter>1</alter><octave>4</octave></pitch>
        <duration>2</duration>
      </note>
      <note>
        <rest />
        <duration>2</duration>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
  </part>
</score-partwise>`;

describe('parseMusicXmlSummary', () => {
  it('extracts notes, segments, tempo, and key from MusicXML', () => {
    const result = parseMusicXmlSummary(SAMPLE_MUSICXML);

    expect(result.tempoBpm).toBe(96);
    expect(result.keySignature).toBe('C major');
    expect(result.notes).toEqual([
      { pitch: 'C4', startSeconds: 0, durationSeconds: 1 },
      { pitch: 'D#4', startSeconds: 1, durationSeconds: 1 },
      { pitch: 'G4', startSeconds: 3, durationSeconds: 2 },
    ]);
    expect(result.segments).toEqual([
      { startSeconds: 0, endSeconds: 2, noteCount: 2 },
      { startSeconds: 3, endSeconds: 5, noteCount: 1 },
    ]);
  });
});
