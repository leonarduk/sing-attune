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
      followCursor: true,
      // Compact layout reduces whitespace; suitable for choir parts at 1080p.
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
    // .mxl is a ZIP; pass as ArrayBuffer. .xml/.musicxml pass as text.
    const isMxl = file.name.toLowerCase().endsWith('.mxl');
    const content: string | ArrayBuffer = isMxl
      ? await file.arrayBuffer()
      : await file.text();

    await this.osmd.load(content);
    this.osmd.render();

    // Commit state only after both phases succeed
    this.scoreModel = model;
    this._loaded = true;
    return model;
  }

  get loaded(): boolean {
    return this._loaded;
  }
}
