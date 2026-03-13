const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFrequency(midi: number): number {
  return 440 * (2 ** ((midi - 69) / 12));
}

export function midiToNoteName(midi: number): string {
  const nearestMidi = Math.round(midi);
  const normalized = ((nearestMidi % 12) + 12) % 12;
  const octave = Math.floor(nearestMidi / 12) - 1;
  return `${NOTE_NAMES[normalized]}${octave}`;
}
