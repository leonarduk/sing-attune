/**
 * SoundfontLoader — loads piano samples from a bundled FluidR3 asset first,
 * then falls back to the gleitz/midi-js-soundfonts mirrors.
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
 * Offline note: packaged builds should resolve the first URL below from local
 * app assets, so playback still works when there is no internet connection.
 */

// Priority order is intentional: use the bundled local asset first so
// packaged/offline environments never depend on runtime CDN access.
export const SOUNDFONT_URLS = [
  '/soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js',
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/acoustic_grand_piano-mp3.js',
  'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/FluidR3_GM/acoustic_grand_piano-mp3.js',
] as const;

const SOUNDFONT_ASSIGNMENT_RE = /MIDI\.Soundfont\.[A-Za-z0-9_]+\s*=/;
const HTML_CONTENT_TYPE_RE = /text\/html|application\/xhtml\+xml/i;

type MirrorFailureType = 'html' | 'http' | 'network' | 'parse';

type MirrorFailure = {
  url: string;
  status: number | null;
  type: MirrorFailureType;
  detail: string;
};

export class SoundfontLoadError extends Error {
  readonly failures: MirrorFailure[];

  constructor(message: string, failures: MirrorFailure[]) {
    super(message);
    this.name = 'SoundfontLoadError';
    this.failures = failures;
  }
}

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

function classifyMirrorError(err: unknown): { type: MirrorFailureType; detail: string } {
  if (err instanceof SoundfontLoadError) {
    return { type: 'parse', detail: err.message };
  }
  if (err instanceof TypeError) {
    return { type: 'network', detail: err.message };
  }
  const detail = err instanceof Error ? err.message : String(err);
  if (/received HTML/i.test(detail)) return { type: 'html', detail };
  if (/HTTP \d+/i.test(detail)) return { type: 'http', detail };
  return { type: 'parse', detail };
}

function formatMirrorFailure(failure: MirrorFailure): string {
  const status = failure.status === null ? 'no-response' : String(failure.status);
  return `${failure.type} [${status}] ${failure.url} — ${failure.detail}`;
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
    const failures: MirrorFailure[] = [];

    for (const url of SOUNDFONT_URLS) {
      let status: number | null = null;
      try {
        // Avoid serving a previously cached corrupt/truncated payload.
        const resp = await fetch(url, { cache: 'no-store' });
        status = resp.status;
        if (!resp.ok) {
          throw new Error(`Soundfont fetch failed (HTTP ${resp.status})`);
        }

        const contentType = resp.headers.get('content-type');
        if (contentType && HTML_CONTENT_TYPE_RE.test(contentType)) {
          throw new Error(`Could not parse soundfont JS: received HTML content-type (${contentType})`);
        }

        const js = await resp.text();
        if (SoundfontLoader.looksLikeHtml(js)) {
          throw new Error('Could not parse soundfont JS: received HTML instead of soundfont data');
        }

        return SoundfontLoader.parseNoteMap(js);
      } catch (err) {
        const { type, detail } = classifyMirrorError(err);
        const failure = { url, status, type, detail } satisfies MirrorFailure;
        failures.push(failure);
        console.warn(
          `[SoundfontLoader] mirror failed (${failure.type}, ${failure.status ?? 'no-response'}): ${failure.url} — ${failure.detail}`,
        );
      }
    }

    const message = `Failed to load soundfont from all mirrors: ${failures.map(formatMirrorFailure).join(' | ')}`;
    console.error(`[SoundfontLoader] ${message}`);
    throw new SoundfontLoadError(message, failures);
  }

  static parseNoteMap(js: string): Record<string, string> {
    if (SoundfontLoader.looksLikeHtml(js)) {
      throw new Error('Could not parse soundfont JS: received HTML instead of soundfont data');
    }

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
          const rawObject = js.slice(objStart, i + 1);
          const sanitizedObject = rawObject.replace(/,\s*}/g, '}');
          try {
            return JSON.parse(sanitizedObject) as Record<string, string>;
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Could not parse soundfont JS: invalid JSON (${detail})`);
          }
        }
      }
    }

    throw new Error('Could not parse soundfont JS: truncated JSON object');
  }

  private static looksLikeHtml(js: string): boolean {
    const trimmed = js.trimStart();
    const normalizedPrefix = trimmed.slice(0, 32).toLowerCase();
    return normalizedPrefix.startsWith('<!doctype') || normalizedPrefix.startsWith('<html');
  }
}
