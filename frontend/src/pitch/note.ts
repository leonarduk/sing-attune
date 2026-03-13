const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Convert a MIDI note number to frequency in Hz (A4 = 440 Hz). */
export function midiToFrequencyHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Convert a (possibly fractional) MIDI value to the nearest note name (e.g. C4). */
export function midiToNoteName(midi: number): string {
  const roundedMidi = Math.round(midi);
  const normalizedIndex = ((roundedMidi % 12) + 12) % 12;
  const note = NOTE_NAMES[normalizedIndex];
  const octave = Math.floor(roundedMidi / 12) - 1;
  return `${note}${octave}`;
}
