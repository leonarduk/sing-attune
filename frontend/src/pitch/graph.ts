import type { PitchFrame } from './socket';
import { classifyGraphTraceColor, type GraphTraceColor } from './graph-colors';

export const GRAPH_MIDI_MIN = 36; // C2
export const GRAPH_MIDI_MAX = 84; // C6
const DEFAULT_VIEWPORT_SEMITONE_SPAN = 24;
const RECENTER_THRESHOLD_RATIO = 0.3;

/** Default tolerance for the target-note band (±50 cents = ±0.5 semitone). */
export const DEFAULT_BAND_CENTS_TOLERANCE = 50;

interface GraphSample {
  tSec: number;
  midi: number;
  expectedMidi: number | null;
  color: GraphTraceColor;
}

export interface PitchGraphOptions {
  windowSeconds?: number;
  backgroundColor?: string;
  /**
   * Half-width of the target-note band in cents (default 50).
   * The band spans [expectedMidi - tolerance/100, expectedMidi + tolerance/100]
   * in MIDI units, rendered as a filled semi-transparent rectangle.
   */
  bandCentsTolerance?: number;
}

interface GridLine {
  midi: number;
  isOctave: boolean;
  isBlackKey: boolean;
  label: string | null;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEYBOARD_GUTTER_PX = 56;

function midiToScaleLabel(midi: number): string | null {
  const note = NOTE_NAMES[midi % 12];
  if (note.includes('#')) return null;
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

export function midiToGraphY(midi: number, height: number, minMidi = GRAPH_MIDI_MIN, maxMidi = GRAPH_MIDI_MAX): number {
  const clamped = Math.max(minMidi, Math.min(maxMidi, midi));
  const norm = (clamped - minMidi) / Math.max(1, maxMidi - minMidi);
  return height - (norm * height);
}

function frequencyToMidi(freq: number): number {
  return 69 + (12 * Math.log2(freq / 440));
}

export function timeToGraphX(sampleSec: number, nowSec: number, width: number, windowSec: number): number {
  const age = nowSec - sampleSec;
  const x = width - ((age / windowSec) * width);
  return Math.max(0, Math.min(width, x));
}

export function pruneSamples(samples: GraphSample[], cutoffSec: number): GraphSample[] {
  return samples.filter((sample) => sample.tSec >= cutoffSec);
}

export function buildSemitoneGrid(minMidi = GRAPH_MIDI_MIN, maxMidi = GRAPH_MIDI_MAX): GridLine[] {
  const lines: GridLine[] = [];
  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const isOctave = midi % 12 === 0;
    const isBlackKey = NOTE_NAMES[midi % 12]?.includes('#') ?? false;
    lines.push({ midi, isOctave, isBlackKey, label: midiToScaleLabel(midi) });
  }
  return lines;
}

/**
 * Returns the canvas Y coordinates for the top and bottom edges of the
 * target-note band centred on `expectedMidi`.
 *
 * @param expectedMidi  MIDI note number for the expected pitch
 * @param centsTolerance  Half-width of the band in cents (e.g. 50)
 * @param height  Canvas height in pixels
 * @returns { topY, bottomY } — topY < bottomY (canvas Y increases downward)
 */
export function targetBandY(
  expectedMidi: number,
  centsTolerance: number,
  height: number,
  minMidi = GRAPH_MIDI_MIN,
  maxMidi = GRAPH_MIDI_MAX,
): { topY: number; bottomY: number } {
  const halfSemitones = centsTolerance / 100;
  const topY = midiToGraphY(expectedMidi + halfSemitones, height, minMidi, maxMidi);
  const bottomY = midiToGraphY(expectedMidi - halfSemitones, height, minMidi, maxMidi);
  return { topY, bottomY };
}

export function traceLineDash(color: GraphTraceColor): number[] {
  if (color === 'red') return [7, 4];
  if (color === 'grey') return [2, 4];
  return [];
}

export class PitchGraphCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: Required<PitchGraphOptions>;
  private samples: GraphSample[] = [];
  private fullRangeMinMidi = GRAPH_MIDI_MIN;
  private fullRangeMaxMidi = GRAPH_MIDI_MAX;
  private viewRangeMinMidi = GRAPH_MIDI_MIN;
  private viewRangeMaxMidi = GRAPH_MIDI_MAX;

  constructor(container: HTMLElement, opts: PitchGraphOptions = {}) {
    this.opts = {
      windowSeconds: opts.windowSeconds ?? 10,
      backgroundColor: opts.backgroundColor ?? '#0d162a',
      bandCentsTolerance: opts.bandCentsTolerance ?? DEFAULT_BAND_CENTS_TOLERANCE,
    };
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    container.appendChild(this.canvas);
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  pushFrame(frame: PitchFrame, expectedMidi: number | null): void {
    this.samples.push({
      tSec: frame.t / 1000,
      midi: frame.midi,
      expectedMidi,
      color: classifyGraphTraceColor(frame.midi, expectedMidi),
    });
  }

  tick(nowSec: number): void {
    const cutoffSec = nowSec - this.opts.windowSeconds;
    this.samples = pruneSamples(this.samples, cutoffSec);
    this.redraw(nowSec);
  }

  setWindowSeconds(sec: number): void {
    this.opts.windowSeconds = Math.max(2, Math.min(30, sec));
  }

  setBandCentsTolerance(cents: number): void {
    this.opts.bandCentsTolerance = Math.max(10, Math.min(200, cents));
  }

  setRange(minFreq: number, maxFreq: number): void {
    const minMidi = frequencyToMidi(minFreq);
    const maxMidi = frequencyToMidi(maxFreq);
    if (!Number.isFinite(minMidi) || !Number.isFinite(maxMidi) || maxMidi <= minMidi) {
      this.resetRange();
      return;
    }
    this.fullRangeMinMidi = minMidi;
    this.fullRangeMaxMidi = maxMidi;
    this.resetViewport();
  }

  resetRange(): void {
    this.fullRangeMinMidi = GRAPH_MIDI_MIN;
    this.fullRangeMaxMidi = GRAPH_MIDI_MAX;
    this.resetViewport();
  }

  autoCenterOnMidi(expectedMidi: number | null): void {
    if (expectedMidi === null) return;

    const fullSpan = this.fullRangeMaxMidi - this.fullRangeMinMidi;
    if (fullSpan <= DEFAULT_VIEWPORT_SEMITONE_SPAN) {
      this.resetViewport();
      return;
    }

    const currentCenter = (this.viewRangeMinMidi + this.viewRangeMaxMidi) / 2;
    const threshold = DEFAULT_VIEWPORT_SEMITONE_SPAN * RECENTER_THRESHOLD_RATIO;
    if (Math.abs(expectedMidi - currentCenter) <= threshold) return;

    const halfSpan = DEFAULT_VIEWPORT_SEMITONE_SPAN / 2;
    const unclampedMin = expectedMidi - halfSpan;
    const minMidi = Math.max(this.fullRangeMinMidi, Math.min(unclampedMin, this.fullRangeMaxMidi - DEFAULT_VIEWPORT_SEMITONE_SPAN));
    this.viewRangeMinMidi = minMidi;
    this.viewRangeMaxMidi = minMidi + DEFAULT_VIEWPORT_SEMITONE_SPAN;
  }

  clear(): void {
    this.samples = [];
    this.redraw(performance.now() / 1000);
  }

  destroy(): void {
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }

  private redraw(nowSec: number): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const plotLeft = Math.min(KEYBOARD_GUTTER_PX, width * 0.2);
    const plotWidth = Math.max(1, width - plotLeft);

    this.ctx.fillStyle = this.opts.backgroundColor;
    this.ctx.fillRect(0, 0, width, height);

    this.drawKeyboardScale(plotLeft, height);
    this.drawYGrid(plotLeft, plotWidth, height);
    this.drawXGrid(nowSec, plotLeft, plotWidth, height);
    // Band must be drawn before the sung trace so the trace renders on top.
    this.drawTargetBand(nowSec, plotLeft, plotWidth, height);
    this.drawTrace(nowSec, plotLeft, plotWidth, height);
  }

  /**
   * Draws the target-note band as a semi-transparent blue filled rectangle
   * for each contiguous segment where the expected MIDI note is the same.
   * A thin centre line is drawn inside the band for pitch precision.
   *
   * Layer order (bottom → top): band fill → centre line → sung trace.
   */
  private drawTargetBand(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    if (this.samples.length === 0) return;

    const tolerance = this.opts.bandCentsTolerance;

    // Walk samples; flush a band rectangle whenever expectedMidi changes or
    // a sample has no expected note.
    let segStart: number | null = null;
    let segEnd: number | null = null;
    let segMidi: number | null = null;

    const flushSegment = (): void => {
      if (segStart === null || segEnd === null || segMidi === null) return;
      const x1 = plotLeft + timeToGraphX(segStart, nowSec, plotWidth, this.opts.windowSeconds);
      const x2 = plotLeft + timeToGraphX(segEnd, nowSec, plotWidth, this.opts.windowSeconds);
      const { topY, bottomY } = targetBandY(segMidi, tolerance, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const bandHeight = Math.max(1, bottomY - topY);

      // Band fill
      this.ctx.fillStyle = 'rgba(100, 180, 255, 0.18)';
      this.ctx.fillRect(x1, topY, x2 - x1, bandHeight);

      // Centre line — exact expected pitch for precision reference
      const centreY = midiToGraphY(segMidi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      this.ctx.strokeStyle = 'rgba(100, 180, 255, 0.75)';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(x1, centreY);
      this.ctx.lineTo(x2, centreY);
      this.ctx.stroke();
    };

    for (const sample of this.samples) {
      if (sample.expectedMidi === null) {
        flushSegment();
        segStart = null;
        segEnd = null;
        segMidi = null;
        continue;
      }

      if (segMidi !== null && sample.expectedMidi !== segMidi) {
        flushSegment();
        segStart = sample.tSec;
        segEnd = sample.tSec;
        segMidi = sample.expectedMidi;
      } else {
        if (segStart === null) segStart = sample.tSec;
        segEnd = sample.tSec;
        segMidi = sample.expectedMidi;
      }
    }
    flushSegment();
  }

  private drawKeyboardScale(plotLeft: number, height: number): void {
    this.ctx.fillStyle = '#0a0f1c';
    this.ctx.fillRect(0, 0, plotLeft, height);

    const lines = buildSemitoneGrid(Math.floor(this.viewRangeMinMidi), Math.ceil(this.viewRangeMaxMidi));
    for (const line of lines) {
      if (!line.isBlackKey) continue;
      const topY = midiToGraphY(line.midi + 0.5, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const bottomY = midiToGraphY(line.midi - 0.5, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const keyHeight = bottomY - topY;
      this.ctx.fillStyle = 'rgba(17, 24, 39, 0.95)';
      this.ctx.fillRect(0, topY, plotLeft * 0.64, keyHeight);
    }

    this.ctx.strokeStyle = 'rgba(168, 190, 220, 0.3)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(plotLeft, 0);
    this.ctx.lineTo(plotLeft, height);
    this.ctx.stroke();
  }

  private drawYGrid(plotLeft: number, plotWidth: number, height: number): void {
    const lines = buildSemitoneGrid(Math.floor(this.viewRangeMinMidi), Math.ceil(this.viewRangeMaxMidi));
    for (const line of lines) {
      const y = midiToGraphY(line.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      this.ctx.strokeStyle = line.isOctave ? 'rgba(168, 190, 220, 0.45)' : 'rgba(168, 190, 220, 0.15)';
      this.ctx.lineWidth = line.isOctave ? 1.5 : 1;
      this.ctx.beginPath();
      this.ctx.moveTo(plotLeft, y);
      this.ctx.lineTo(plotLeft + plotWidth, y);
      this.ctx.stroke();

      if (line.label) {
        this.ctx.fillStyle = '#c6d8f3';
        this.ctx.font = '12px system-ui, sans-serif';
        this.ctx.fillText(line.label, 5, y - 2);
      }
    }
  }

  private drawXGrid(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    const newestWhole = Math.floor(nowSec);
    const oldest = nowSec - this.opts.windowSeconds;

    this.ctx.strokeStyle = 'rgba(240, 240, 255, 0.15)';
    this.ctx.lineWidth = 1;

    for (let sec = newestWhole; sec >= oldest; sec -= 1) {
      const x = plotLeft + timeToGraphX(sec, nowSec, plotWidth, this.opts.windowSeconds);
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
  }

  private drawTrace(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    if (this.samples.length < 2) return;

    this.ctx.lineWidth = 2;

    for (let i = 1; i < this.samples.length; i += 1) {
      const prev = this.samples[i - 1];
      const next = this.samples[i];

      const x1 = plotLeft + timeToGraphX(prev.tSec, nowSec, plotWidth, this.opts.windowSeconds);
      const y1 = midiToGraphY(prev.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const x2 = plotLeft + timeToGraphX(next.tSec, nowSec, plotWidth, this.opts.windowSeconds);
      const y2 = midiToGraphY(next.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);

      this.ctx.strokeStyle = this.cssColor(next.color);
      this.ctx.setLineDash(traceLineDash(next.color));
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }

    this.ctx.setLineDash([]);
  }

  private cssColor(color: GraphTraceColor): string {
    if (color === 'green') return '#39d98a';
    if (color === 'red') return '#ff9f1c';
    return '#9aa4b2';
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw(performance.now() / 1000);
  };

  private resetViewport(): void {
    const fullSpan = this.fullRangeMaxMidi - this.fullRangeMinMidi;
    if (fullSpan <= DEFAULT_VIEWPORT_SEMITONE_SPAN) {
      this.viewRangeMinMidi = this.fullRangeMinMidi;
      this.viewRangeMaxMidi = this.fullRangeMaxMidi;
      return;
    }
    this.viewRangeMinMidi = this.fullRangeMinMidi;
    this.viewRangeMaxMidi = this.fullRangeMinMidi + DEFAULT_VIEWPORT_SEMITONE_SPAN;
  }
}
