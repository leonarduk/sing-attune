import { describe, expect, it } from 'vitest';

import { classifyVoiceType, getVoiceTypeById } from './voice-type';

describe('classifyVoiceType', () => {
  it('classifies bass ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 41, highestMidi: 63, stableNoteCount: 12 });
    expect(result?.id).toBe('bass');
  });

  it('classifies baritone ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 44, highestMidi: 66, stableNoteCount: 12 });
    expect(result?.id).toBe('baritone');
  });

  it('classifies tenor ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 49, highestMidi: 71, stableNoteCount: 12 });
    expect(result?.id).toBe('tenor');
  });

  it('classifies alto ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 55, highestMidi: 78, stableNoteCount: 12 });
    expect(result?.id).toBe('alto');
  });

  it('classifies mezzo-soprano ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 58, highestMidi: 80, stableNoteCount: 12 });
    expect(result?.id).toBe('mezzo-soprano');
  });

  it('classifies soprano ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 61, highestMidi: 83, stableNoteCount: 12 });
    expect(result?.id).toBe('soprano');
  });

  it('returns null when there are not enough stable notes or span', () => {
    expect(classifyVoiceType({ lowestMidi: 48, highestMidi: 72, stableNoteCount: 9 })).toBeNull();
    expect(classifyVoiceType({ lowestMidi: 60, highestMidi: 64, stableNoteCount: 15 })).toBeNull();
  });
});

describe('getVoiceTypeById', () => {
  it('returns voice type for known id', () => {
    expect(getVoiceTypeById('tenor')?.label).toBe('Tenor');
  });

  it('returns null for unknown id', () => {
    expect(getVoiceTypeById('countertenor')).toBeNull();
  });
});
