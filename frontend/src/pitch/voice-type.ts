export type VoiceTypeId = 'bass' | 'baritone' | 'tenor' | 'alto' | 'mezzo-soprano' | 'soprano';

export interface VoiceType {
  id: VoiceTypeId;
  label: string;
  lowMidi: number;
  highMidi: number;
  male: boolean;
}

export interface VoiceTypeClassificationInput {
  lowestMidi: number;
  highestMidi: number;
  stableNoteCount: number;
}

export const VOICE_TYPES: VoiceType[] = [
  { id: 'bass', label: 'Bass', lowMidi: 40, highMidi: 64, male: true },
  { id: 'baritone', label: 'Baritone', lowMidi: 43, highMidi: 67, male: true },
  { id: 'tenor', label: 'Tenor', lowMidi: 48, highMidi: 72, male: true },
  { id: 'alto', label: 'Alto', lowMidi: 55, highMidi: 79, male: false },
  { id: 'mezzo-soprano', label: 'Mezzo-soprano', lowMidi: 57, highMidi: 81, male: false },
  { id: 'soprano', label: 'Soprano', lowMidi: 60, highMidi: 84, male: false },
];

const MIN_STABLE_NOTES = 10;
const MIN_SEMITONE_SPAN = 5;

export function classifyVoiceType(input: VoiceTypeClassificationInput): VoiceType | null {
  if (!Number.isFinite(input.lowestMidi) || !Number.isFinite(input.highestMidi)) return null;
  if (input.stableNoteCount < MIN_STABLE_NOTES) return null;
  const span = input.highestMidi - input.lowestMidi;
  if (!Number.isFinite(span) || span < MIN_SEMITONE_SPAN) return null;

  const midpoint = (input.lowestMidi + input.highestMidi) / 2;
  let bestMatch: VoiceType | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const voiceType of VOICE_TYPES) {
    const voiceMidpoint = (voiceType.lowMidi + voiceType.highMidi) / 2;
    const distance = Math.abs(midpoint - voiceMidpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = voiceType;
    }
  }

  return bestMatch;
}

export function getVoiceTypeById(id: string | null): VoiceType | null {
  if (!id) return null;
  return VOICE_TYPES.find((voiceType) => voiceType.id === id) ?? null;
}
