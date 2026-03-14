import type { ScoreModel, NoteModel } from '../score/renderer';
import { elapsedToBeat } from '../score/timing';
import { expectedNoteAtBeat, type DotColor } from './accuracy';
import { createPitchInterpreter, noteKey, type PitchInterpreter } from './interpretation';

export const MIN_CONFIDENCE_THRESHOLD = 0.6;
export const MAX_CONFIDENCE_THRESHOLD = 0.95;
export const MIN_TRAIL_MS = 500;
export const MAX_TRAIL_MS = 5000;

/**
 * User-configurable overlay settings.
 *
 * - `confidenceThreshold` is a 0-1 confidence cutoff.
 * - `trailMs` is the visible dot trail length in milliseconds.
 */
export interface OverlaySettings {
  confidenceThreshold: number;
  trailMs: number;
}

export function normalizeOverlaySettings(settings: OverlaySettings): OverlaySettings {
  const threshold = Number.isFinite(settings.confidenceThreshold)
    ? settings.confidenceThreshold
    : MIN_CONFIDENCE_THRESHOLD;
  const trailMs = Number.isFinite(settings.trailMs)
    ? settings.trailMs
    : 2000;

  return {
    confidenceThreshold: Math.min(MAX_CONFIDENCE_THRESHOLD, Math.max(MIN_CONFIDENCE_THRESHOLD, threshold)),
    trailMs: Math.min(MAX_TRAIL_MS, Math.max(MIN_TRAIL_MS, trailMs)),
  };
}

interface PitchFrame {
  t: number;
  midi: number;
  conf: number;
}

interface Dot {
  x: number;
  y: number;
  color: DotColor;
  wallMs: number;
}

export class PitchOverlay {
  private readonly container: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly model: ScoreModel;
  private notesForPart: NoteModel[];
  private midiMin: number;
  private midiMax: number;
  private dots: Dot[] = [];
  private settings: OverlaySettings;
  private readonly interpreter: PitchInterpreter;

  constructor(container: HTMLDivElement, model: ScoreModel, part: string, settings?: OverlaySettings) {
    this.container = container;
    this.model = model;
    this.notesForPart = [];
    this.midiMin = 48;
    this.midiMax = 84;
    this.setPart(part);
    this.settings = normalizeOverlaySettings(settings ?? { confidenceThreshold: MIN_CONFIDENCE_THRESHOLD, trailMs: 2000 });
    this.interpreter = createPitchInterpreter();

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '10';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.container.appendChild(this.canvas);
    this.resize();
    window.addEventListener('resize', this.resize);
    this.container.addEventListener('scroll', this.redraw);
  }

  updatePart(part: string): void {
    this.setPart(part);
    this.interpreter.reset();
    this.dots = [];
    this.redraw();
  }

  applySettings(settings: OverlaySettings): void {
    this.settings = normalizeOverlaySettings(settings);
    this.prune();
    this.redraw();
  }

  destroy(): void {
    window.removeEventListener('resize', this.resize);
    this.container.removeEventListener('scroll', this.redraw);
    this.canvas.remove();
  }

  clear(): void {
    this.interpreter.reset();
    this.dots = [];
    this.redraw();
  }

  pushFrame(frame: PitchFrame, cursorX: number): void {
    const beat = elapsedToBeat(frame.t, 0, this.model.tempo_marks);
    const expected = expectedNoteAtBeat(beat, this.notesForPart);

    // No dot during rests or before the selected part's first note
    if (expected === null) return;

    const interpreted = this.interpreter.processFrame({
      t: frame.t,
      midi: frame.midi,
      conf: frame.conf,
      expectedMidi: expected.midi,
      expectedNoteKey: noteKey(expected.beat_start, expected.midi, expected.part),
      confidenceThreshold: this.settings.confidenceThreshold,
    });
    const y = this.midiToY(interpreted.filteredMidi);

    this.dots.push({ x: cursorX, y, color: interpreted.color, wallMs: performance.now() });
    this.prune();
    this.redraw();
  }

  private midiToY(midi: number): number {
    const h = this.container.clientHeight;
    const norm = (midi - this.midiMin) / Math.max(1, this.midiMax - this.midiMin);
    return h - norm * (h - 40) - 20;
  }

  private setPart(part: string): void {
    this.notesForPart = this.model.notes.filter((n) => n.part === part);
    this.midiMin = Math.min(...this.notesForPart.map((n) => n.midi), 48);
    this.midiMax = Math.max(...this.notesForPart.map((n) => n.midi), 84);
  }

  private prune(): void {
    const cutoff = performance.now() - this.settings.trailMs;
    this.dots = this.dots.filter((d) => d.wallMs >= cutoff);
  }

  private redraw = (): void => {
    this.resize();
    const now = performance.now();
    const scrollLeft = this.container.scrollLeft;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const dot of this.dots) {
      const age = now - dot.wallMs;
      const alpha = Math.max(0, 1 - age / this.settings.trailMs);
      if (alpha <= 0) continue;

      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = this.colorToCss(dot.color);
      this.ctx.beginPath();
      // Dot x is recorded in score-content coordinates. Convert back to
      // viewport coordinates each redraw so dots stay attached to notes while
      // the score container auto-scrolls.
      this.ctx.arc(dot.x - scrollLeft, dot.y, 4, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  };

  private colorToCss(color: DotColor): string {
    switch (color) {
      case 'green': return '#4caf50';
      case 'amber': return '#ffa726';
      case 'red': return '#e53935';
      case 'grey': return '#9e9e9e';
    }
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
}
