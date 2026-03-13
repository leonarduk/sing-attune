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
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

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

export class ScoreRenderer {
  readonly osmd: OpenSheetMusicDisplay;
  private _loaded = false;
  public scoreModel: ScoreModel | null = null;

  constructor(container: HTMLElement) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
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
   */
  async load(file: File): Promise<ScoreModel> {
    // Phase 1: backend parse
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/score', { method: 'POST', body: form });
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

    // Phase 2: OSMD render
    // File extends Blob; osmd.load() accepts Blob and handles both .xml and
    // .mxl internally (JSZip detects the ZIP magic bytes automatically).
    // Do NOT pass ArrayBuffer — it is not in the osmd.load() type signature.
    await this.osmd.load(file);
    this.osmd.render();

    // Commit state only after both phases succeed
    this.scoreModel = model;
    this._loaded = true;
    return model;
  }

  get loaded(): boolean {
    return this._loaded;
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
}
