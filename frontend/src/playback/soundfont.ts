/**
 * SoundfontLoader — loads GM instrument samples from a bundled FluidR3 asset
 * first, then falls back to the gleitz/midi-js-soundfonts mirrors.
 *
 * Format: MIDI.js-style JS file containing base64-encoded MP3 samples for
 * each note of the instrument. We fetch the file, extract the JSON object,
 * decode each sample into an AudioBuffer, and build a MIDI-number →
 * AudioBuffer map.
 *
 * Nearest-sample strategy: the gleitz soundfonts only include a subset of
 * MIDI notes (every 2–4 semitones). getBuffer() returns the closest sampled
 * note. Callers should apply AudioBufferSourceNode.detune to pitch-correct;
 * use getNearestSampledMidi() to find the offset in cents.
 *
 * Offline note: packaged builds resolve the first URL for each instrument
 * from local app assets, so playback still works when there is no internet
 * connection — see public/soundfonts/FluidR3_GM/. That directory's README
 * records the asset provenance/licence and the "add a new bundled voice"
 * procedure (#403); it also explains why `voice_oohs` (below) is CDN-only.
 *
 * Instrument selection (#361): the instrument is a parameter rather than a
 * hardcoded piano URL, so the settings panel can offer a vocal timbre
 * (Choir Aahs / Voice Oohs) as the default playback voice — piano sounds
 * much less useful for singing practice. See buildSoundfontUrls().
 */

// GM instrument ids we ship as selectable playback voices. Values match the
// gleitz/midi-js-soundfonts FluidR3_GM filenames exactly (used to build URLs).
export type PlaybackInstrumentId = 'acoustic_grand_piano' | 'choir_aahs' | 'voice_oohs';

export interface PlaybackInstrumentOption {
  id: PlaybackInstrumentId;
  label: string;
}

// Order shown in the settings "Playback voice" select. Vocal timbres first
// since they're the recommended choice for singing practice (#361 AC: the
// default must be a vocal timbre, not piano).
//
// Bundled vs. CDN-only (#403): `acoustic_grand_piano` and `choir_aahs` have a
// local copy under public/soundfonts/FluidR3_GM/ and work offline. `voice_oohs`
// is deliberately NOT bundled — a third ~2.8 MB binary wasn't judged worth the
// bundle-size cost given it mostly duplicates `choir_aahs`. Selecting it in an
// offline/packaged build exhausts every CDN mirror and silently falls back to
// piano (see loadNoteMapForInstrument()). See the README in that directory for
// the decision and the steps to bundle it locally if that tradeoff changes.
export const PLAYBACK_INSTRUMENTS: PlaybackInstrumentOption[] = [
  { id: 'choir_aahs', label: 'Choir Aahs (vocal)' },
  { id: 'voice_oohs', label: 'Voice Oohs (vocal)' },
  { id: 'acoustic_grand_piano', label: 'Piano' },
];

// Default playback voice is vocal, not piano — the original ask was that
// piano playback doesn't sound enough like a voice for singing practice.
export const DEFAULT_PLAYBACK_INSTRUMENT_ID: PlaybackInstrumentId = 'choir_aahs';

// Last-resort instrument if the selected voice fails to load from every
// mirror. Piano is the best-tested/most-reliable bundled asset, and the
// synth oscillator fallback in engine.ts is the final safety net after this.
export const FALLBACK_PLAYBACK_INSTRUMENT_ID: PlaybackInstrumentId = 'acoustic_grand_piano';

// Priority order is intentional: use the bundled local asset first so
// packaged/offline environments never depend on runtime CDN access.
// `{instrument}` is substituted with the GM instrument id.
const SOUNDFONT_URL_TEMPLATES = [
  '/soundfonts/FluidR3_GM/{instrument}-mp3.js',
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/{instrument}-mp3.js',
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/{instrument}-mp3.js',
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/{instrument}-mp3.js',
  'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/FluidR3_GM/{instrument}-mp3.js',
] as const;

/** Build the mirror URL list (bundled asset first, then CDN mirrors) for a given GM instrument id. */
export function buildSoundfontUrls(instrumentId: PlaybackInstrumentId): string[] {
  return SOUNDFONT_URL_TEMPLATES.map((template) => template.replace('{instrument}', instrumentId));
}

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
  private readonly _instrumentId: PlaybackInstrumentId;
  private _buffers = new Map<number, AudioBuffer>();
  private _sampledMidis: number[] = [];
  private _loaded = false;

  constructor(instrumentId: PlaybackInstrumentId = DEFAULT_PLAYBACK_INSTRUMENT_ID) {
    this._instrumentId = instrumentId;
  }

  get instrumentId(): PlaybackInstrumentId { return this._instrumentId; }

  /**
   * Fetch and decode all samples for the selected instrument. Resolves when
   * every AudioBuffer is ready. Logs a summary on success; individual note
   * decode errors are silently skipped (sample is simply absent from the map).
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async load(ctx: AudioContext): Promise<void> {
    if (this._loaded) return;

    // 1. Fetch the MIDI.js-format soundfont JS file for the selected voice.
    // Some CDN mirrors occasionally return a corrupt/truncated payload; we
    // retry against a secondary mirror before falling back to piano, then
    // to synth mode (#361: instrument load failures must never throw up to
    // the caller — see ensureSoundfontLoaded()'s synth-fallback mode).
    const noteMap = await SoundfontLoader.loadNoteMapForInstrument(this._instrumentId);

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

  /**
   * Load the note map for `instrumentId`, trying every mirror in order.
   * If every mirror fails and `instrumentId` is not already the fallback
   * piano voice, retries once against the piano voice before giving up —
   * this is the "instrument load failure falls back to piano" leg of the
   * fallback chain (#361 AC); the synth-oscillator leg lives one level up,
   * in engine.ts, triggered when this whole method still throws.
   */
  private static async loadNoteMapForInstrument(
    instrumentId: PlaybackInstrumentId,
  ): Promise<Record<string, string>> {
    try {
      return await SoundfontLoader.loadNoteMapFromMirrors(instrumentId);
    } catch (err) {
      if (instrumentId === FALLBACK_PLAYBACK_INSTRUMENT_ID) throw err;
      console.warn(
        `[SoundfontLoader] instrument "${instrumentId}" failed on every mirror, falling back to "${FALLBACK_PLAYBACK_INSTRUMENT_ID}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return SoundfontLoader.loadNoteMapFromMirrors(FALLBACK_PLAYBACK_INSTRUMENT_ID);
    }
  }

  private static async loadNoteMapFromMirrors(
    instrumentId: PlaybackInstrumentId,
  ): Promise<Record<string, string>> {
    const failures: MirrorFailure[] = [];

    for (const url of buildSoundfontUrls(instrumentId)) {
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
