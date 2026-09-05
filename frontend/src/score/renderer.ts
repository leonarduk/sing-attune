/**
 * ScoreRenderer — wraps OpenSheetMusicDisplay and the backend /score endpoint.
 *
 * Responsibilities:
 *   1. Upload the MusicXML file to the backend to obtain ScoreModel JSON
 *      (beat-accurate timing data for the cursor and pitch overlay).
 *   2. Feed the raw file bytes to OSMD for visual rendering.
 *
 * Separation of concerns: OSMD renders pixels; ScoreModel drives timing.
 * Never use OSMD note positions for timing — they differ from the backend model.
 */
import { MXLFile, OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { extractMeasureHitZones, type MeasureHitZone } from './click-seek';
import { OsmdScoreCursor, type ScoreCursor } from './cursor';
import { resolveFallbackTitle } from './title-fallback';
import { apiUrl } from '../services/backend';

const OSMD_SKY_BOTTOM_LINE_WARNING = 'Not enough lines for SkyBottomLine calculation';

/**
 * OSMD emits this warning for some valid scores/parts in compact layout.
 * It is noisy and currently non-actionable for our app, so we suppress only
 * this exact warning while OSMD load/render work is in progress.
 */
export async function withSuppressedOsmdWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    const hasKnownNoise = args.some(
      (arg) => typeof arg === 'string' && arg.includes(OSMD_SKY_BOTTOM_LINE_WARNING),
    );
    if (hasKnownNoise) {
      return;
    }
    originalWarn(...args);
  };

  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Recover the raw MusicXML text from a score file so it can be scanned for
 * the title-fallback heuristic (#698) independently of OSMD's own parsing.
 *
 * Reuses OSMD's own MXLFile helper (already a dependency, so this adds no
 * new package) rather than assuming the file is either always zipped
 * (.mxl) or always plain text (.xml) — MXLFile.tryUnzip() detects which one
 * it is. Best-effort: any failure here just means the fallback heuristic
 * can't run for this file, never that the score fails to load.
 */
async function extractMusicXmlText(file: Blob): Promise<string | null> {
  try {
    const mxl = new MXLFile(file);
    const isZip = await mxl.tryUnzip();
    if (isZip && mxl.unzipSuccessful) {
      return await mxl.getXmlString();
    }
    return await file.text();
  } catch {
    return null;
  }
}

export interface NoteModel {
  midi: number;
  beat_start: number;
  duration: number;
  measure: number;
  part: string;
  lyric: string | null;
}

export interface TempoMark {
  beat: number;
  bpm: number;
}

export interface TimeSignature {
  beat: number;
  numerator: number;
  denominator: number;
}

export interface ScoreModel {
  title: string;
  parts: string[];
  notes: NoteModel[];
  tempo_marks: TempoMark[];
  time_signatures: TimeSignature[];
  total_beats: number;
}

/** Stable boundary consumed by playback, practice, and overlay features. */
export interface ScoreRenderer {
  readonly loaded: boolean;
  readonly scoreModel: ScoreModel | null;
  /**
   * Implementations must tolerate load() being invoked again before a
   * previous call has resolved: the newer call wins, and the older
   * (superseded) call must reject rather than commit its stale result
   * over the newer one's state. See #435.
   */
  load(file: File): Promise<ScoreModel>;
  createCursor(model: ScoreModel): ScoreCursor;
  /**
   * Clickable/loopable regions in the rendered score, in screen-pixel
   * coordinates mapped to beat positions. Renderer-agnostic: callers use
   * this to hit-test clicks and drive loop overlays without knowing how
   * the implementation computed the geometry (OSMD internals stay private
   * to OsmdScoreRenderer / click-seek.ts).
   */
  getMeasureHitZones(): MeasureHitZone[];
  setHighlightedPart(partName: string): void;
  applyVisualTranspose(semitones: number): void;
}

/** OSMD-backed implementation of the stable score-rendering boundary. */
export class OsmdScoreRenderer implements ScoreRenderer {
  private readonly osmd: OpenSheetMusicDisplay;
  private _loaded = false;
  private visualTransposeSemitones = 0;
  public scoreModel: ScoreModel | null = null;

  // Reentrancy guard (#435): load() has two await points (backend /score
  // POST, then osmd.load()/render()). Without a generation token, calling
  // load() again before the first call resolves lets the two calls race on
  // `this.osmd` / `this.scoreModel` / `this._loaded`, with last-to-*resolve*
  // winning rather than last-to-*start*. Each load() call captures the
  // post-increment token; if a newer call has started by the time an
  // earlier call reaches a checkpoint, the earlier call aborts instead of
  // touching shared state. Mirrors the loadGeneration idiom already used in
  // services/audio-context.ts (#361).
  private generation = 0;

  constructor(container: HTMLElement) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
      // OSMD's `drawingParameters: 'compacttight'` (below) internally calls
      // DrawingParameters.setForCompactMode(), which sets `DrawCredits = false`
      // — silently disabling subtitle/composer/lyricist/copyright rendering
      // (only the title survives, because we re-enable it explicitly above).
      // That meant a score's dedication, arranger/composer credits, and
      // footnote never reached the DOM even though OSMD had parsed them from
      // the MusicXML `credit-words` correctly (verified via osmd.Sheet.Subtitle
      // /.Composer/.Lyricist at runtime). `drawCredits: true` is applied by
      // OSMD *after* the drawingParameters preset (see OpenSheetMusicDisplay.
      // setOptions()), so it restores the full title-page credit block without
      // giving up the compact layout's reduced staff/system spacing. See #649.
      drawCredits: true,
      // followCursor scrolls the browser *window*, not our #score-container div.
      // ScoreCursor._scrollToCursor() calls scrollIntoView() on the cursor element
      // which handles container-level scroll correctly. Keeping this true would
      // cause double-scroll jank, so it is disabled.
      followCursor: false,
      // Compact layout reduces whitespace; suitable for choir parts at 1080p.
      // Typed as string in IOSMDOptions — no cast needed.
      drawingParameters: 'compacttight',
    });
  }

  /**
   * Load a MusicXML or MXL file.
   *
   * Two-phase:
   *   Phase 1 — POST to /score → ScoreModel (timing data).
   *   Phase 2 — OSMD.load() with raw file content → visual render.
   *
   * Both must succeed; a failure in either leaves the renderer in the
   * previous state (not partially loaded).
   *
   * Reentrant-safe: if load() is called again before a previous call
   * resolves, the previous call's Promise rejects instead of committing
   * once it catches up — see the `generation` field (#435).
   */
  async load(file: File): Promise<ScoreModel> {
    // Claim this call's generation before any await so a call that starts
    // later always has a strictly higher token — "last to start" is
    // unambiguous even though awaits below may resolve out of order.
    const myGeneration = ++this.generation;

    // Phase 1: backend parse
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch(apiUrl('/score'), { method: 'POST', body: form });
    if (!resp.ok) {
      let detail: string;
      try {
        detail = ((await resp.json()) as { detail?: string }).detail ?? resp.statusText;
      } catch {
        detail = resp.statusText;
      }
      throw new Error(`Score parse failed (HTTP ${resp.status}): ${detail}`);
    }
    const model = (await resp.json()) as ScoreModel;

    // A newer load() call started while we awaited the backend parse.
    // Bail out *before* touching `this.osmd` so this stale call's render
    // can never land after (and visually clobber) the newer call's — see
    // the generation-token comment on the `generation` field above.
    if (myGeneration !== this.generation) {
      throw new Error('Score load superseded by a newer load() call');
    }

    // Phase 2: OSMD render
    // File extends Blob; osmd.load() accepts Blob and handles both .xml and
    // .mxl internally (JSZip detects the ZIP magic bytes automatically).
    // Do NOT pass ArrayBuffer — it is not in the osmd.load() type signature.
    await withSuppressedOsmdWarnings(async () => {
      await this.osmd.load(file);
      // Must run after osmd.load() (so this.osmd.Sheet exists to override)
      // and before osmd.render() (so the override is what actually gets
      // drawn) — see #698.
      await this.applyTitleFallback(file);
      this.osmd.render();
    });

    // A newer call could also have started during the (slower) OSMD phase.
    // Re-check before committing so a stale call can never overwrite the
    // newer call's scoreModel/loaded state (#435).
    if (myGeneration !== this.generation) {
      throw new Error('Score load superseded by a newer load() call');
    }

    // Commit state only after both phases succeed
    this.scoreModel = model;
    this._loaded = true;
    this.applyVisualTranspose(this.visualTransposeSemitones);
    return model;
  }

  /**
   * Overrides OSMD's title if the largest-font-credit fallback heuristic
   * (#698) finds one. No-op (leaves OSMD's own title resolution alone) for
   * the well-formed case — see resolveFallbackTitle's docstring for exactly
   * when it does and doesn't fire.
   */
  private async applyTitleFallback(file: Blob): Promise<void> {
    const xmlText = await extractMusicXmlText(file);
    if (!xmlText) return;

    let xmlDoc: Document;
    try {
      xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
    } catch {
      return;
    }
    if (xmlDoc.getElementsByTagName('parsererror').length > 0) return;

    const fallback = resolveFallbackTitle(xmlDoc);
    if (!fallback) return;

    const sheet = this.osmd.Sheet;
    if (!sheet) return;
    sheet.TitleString = fallback.title;

    // The promoted text is still sitting in whatever (wrong) field the
    // source file's credit-type mislabeled it as — e.g. Lyricist for
    // homeward_bound.mxl's "HOMEWARD BOUND". Clear whichever OSMD Sheet
    // credit-string field currently holds exactly that text (other than
    // TitleString, which was just set to it on purpose) so OSMD doesn't draw
    // the same text twice: once as the title, once again under its original,
    // mislabeled role. Checking every credit-string field OSMD's Sheet
    // exposes — rather than switching on fallback.creditType against a
    // hardcoded list — means this doesn't need updating if some other
    // credit-type (e.g. "arranger") turns out to be similarly mislabeled in
    // some other file.
    const creditFields = [
      'SubtitleString',
      'ComposerString',
      'LyricistString',
      'CopyrightString',
    ] as const;
    for (const field of creditFields) {
      if (sheet[field] === fallback.title) {
        sheet[field] = '';
      }
    }
  }

  get loaded(): boolean {
    return this._loaded;
  }

  createCursor(model: ScoreModel): ScoreCursor {
    return new OsmdScoreCursor(this.osmd, model);
  }

  getMeasureHitZones(): MeasureHitZone[] {
    return extractMeasureHitZones(this.osmd);
  }

  /**
   * Best-effort part highlighting hook.
   *
   * OSMD 1.8 does not expose a stable public API to recolor or isolate one
   * rendered part/voice after render() completes. The cursor can highlight the
   * current time position, but not persistently style a selected part.
   * Keep this hook so app.ts can call it if OSMD gains such API later.
   */
  setHighlightedPart(_partName: string): void {
    // Intentionally a no-op due to current OSMD public API limitations.
  }

  /** Apply visual transposition to score notation and re-render the sheet. */
  applyVisualTranspose(semitones: number): void {
    const roundedSemitones = Math.round(semitones);
    const clampedSemitones = Math.max(-24, Math.min(24, roundedSemitones));
    this.visualTransposeSemitones = clampedSemitones;

    if (!this._loaded || !this.osmd.Sheet) return;
    if (this.osmd.Sheet.Transpose === clampedSemitones) return;

    this.osmd.Sheet.Transpose = clampedSemitones;
    this.osmd.updateGraphic();
    this.osmd.render();
  }
}
