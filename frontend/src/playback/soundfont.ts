/**
 * SoundfontLoader — loads piano samples from the gleitz/midi-js-soundfonts CDN.
 *
 * Format: MIDI.js-style JS file containing base64-encoded MP3 samples for
 * each piano note. We fetch the file, extract the JSON object, decode each
 * sample into an AudioBuffer, and build a MIDI-number → AudioBuffer map.
 *
 * Nearest-sample strategy: the gleitz soundfont only includes a subset of
 * MIDI notes (every 2–4 semitones). getBuffer() returns the closest sampled
 * note. Callers should apply AudioBufferSourceNode.detune to pitch-correct;
 * use getNearestSampledMidi() to find the offset in cents.
 *
 * Offline note: Electron has internet access by default. For fully-offline
 * use, bundle the JS file as a Vite static asset and point SOUNDFONT_URL
 * at the local path (e.g. '/assets/acoustic_grand_piano-mp3.js').
 */

const SOUNDFONT_URLS = [
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js',
] as const;

const SOUNDFONT_ASSIGNMENT_RE = /MIDI\.Soundfont\.[A-Za-z0-9_]+\s*=/;

// Flat-notation names matching the gleitz soundfont key names exactly.
// MIDI 0 = C-1, MIDI 60 = C4, MIDI 69 = A4.
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + octave;
}

function noteNameToMidi(name: string): number {
  // Handles both flat (Db) and sharp (#) notation from CDN data.
  // Sharp → flat mapping for completeness:
  const SHARP_TO_FLAT: Record<string, string> = {
    'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
  };
  const m = name.match(/^([A-G][b#]?)(-?\d+)$/);
  if (!m) return -1;
  let [, note, octStr] = m;
  note = SHARP_TO_FLAT[note] ?? note;
  const octave = parseInt(octStr, 10);
  const idx = (NOTE_NAMES as readonly string[]).indexOf(note);
  if (idx < 0) return -1;
  return (octave + 1) * 12 + idx;
}

export class SoundfontLoader {
  private _buffers = new Map<number, AudioBuffer>();
  private _sampledMidis: number[] = [];
  private _loaded = false;

  /**
   * Fetch and decode all piano samples. Resolves when every AudioBuffer is
   * ready. Logs a summary on success; individual note decode errors are
   * silently skipped (sample is simply absent from the map).
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async load(ctx: AudioContext): Promise<void> {
    if (this._loaded) return;

    // 1. Fetch the MIDI.js-format soundfont JS file.
    // Some CDN mirrors occasionally return a corrupt/truncated payload; we
    // retry against a secondary mirror before falling back to synth mode.
    const noteMap = await SoundfontLoader.loadNoteMapFromMirror();

    // 3. Decode all samples concurrently
    const entries = Object.entries(noteMap);
    await Promise.all(
      entries.map(async ([noteName, dataUrl]) => {
        const midi = noteNameToMidi(noteName);
        if (midi < 0) return;

        // dataUrl = "data:audio/mp3;base64,<data>"
        const b64 = dataUrl.split(',')[1];
        if (!b64) return;

        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          // decodeAudioData takes ownership of the ArrayBuffer
          const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
          this._buffers.set(midi, buf);
        } catch {
          // Skip undecodable samples — not fatal for playback
        }
      }),
    );

    this._sampledMidis = Array.from(this._buffers.keys()).sort((a, b) => a - b);
    this._loaded = true;
    console.info(
      `[SoundfontLoader] loaded ${this._buffers.size}/${entries.length} samples`,
    );
  }

  /**
   * Return the AudioBuffer for the nearest sampled MIDI note.
   * Returns null only if load() has not been called or all decodes failed.
   */
  getBuffer(midi: number): AudioBuffer | null {
    if (this._buffers.has(midi)) return this._buffers.get(midi)!;
    const nearest = this.getNearestSampledMidi(midi);
    return nearest !== null ? (this._buffers.get(nearest) ?? null) : null;
  }

  /**
   * Return the MIDI number of the nearest sampled note to `midi`.
   * Use the difference (midi - nearest) * 100 as AudioBufferSourceNode.detune
   * to pitch-correct the sample to the desired note.
   */
  getNearestSampledMidi(midi: number): number | null {
    if (this._sampledMidis.length === 0) return null;
    let nearest = this._sampledMidis[0];
    let minDist = Math.abs(nearest - midi);
    for (const m of this._sampledMidis) {
      const d = Math.abs(m - midi);
      if (d < minDist) { minDist = d; nearest = m; }
      if (m > midi + minDist) break; // sorted, no point continuing
    }
    return nearest;
  }

  get loaded(): boolean { return this._loaded; }

  get sampleCount(): number { return this._buffers.size; }

  // Exposed for tests
  static midiToNoteName = midiToNoteName;
  static noteNameToMidi = noteNameToMidi;

  private static async loadNoteMapFromMirror(): Promise<Record<string, string>> {
    let lastError: unknown;
    for (const url of SOUNDFONT_URLS) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`Soundfont fetch failed (HTTP ${resp.status}): ${url}`);
        }
        const js = await resp.text();
        return SoundfontLoader.parseNoteMap(js);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('Soundfont fetch failed from all mirrors');
  }

  static parseNoteMap(js: string): Record<string, string> {
    const assignment = js.match(SOUNDFONT_ASSIGNMENT_RE);
    if (!assignment || assignment.index === undefined) {
      throw new Error('Could not parse soundfont JS: no JSON object found');
    }

    const objStart = js.indexOf('{', assignment.index + assignment[0].length);
    if (objStart < 0) throw new Error('Could not parse soundfont JS: no JSON object found');

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = objStart; i < js.length; i++) {
      const ch = js[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (ch === '\\') {
          escaping = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(js.slice(objStart, i + 1)) as Record<string, string>;
        }
      }
    }

    throw new Error('Could not parse soundfont JS: no JSON object found');
  }
}
