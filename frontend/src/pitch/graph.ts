import type { PitchFrame } from './socket';
import { classifyGraphTraceColor, type GraphTraceColor } from './graph-colors';

export const GRAPH_MIDI_MIN = 36; // C2
export const GRAPH_MIDI_MAX = 84; // C6

interface GraphSample {
  tSec: number;
  midi: number;
  color: GraphTraceColor;
}

export interface PitchGraphOptions {
  windowSeconds?: number;
  backgroundColor?: string;
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

export class PitchGraphCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: Required<PitchGraphOptions>;
  private samples: GraphSample[] = [];
  private timeOffsetSec: number | null = null;

  constructor(container: HTMLElement, opts: PitchGraphOptions = {}) {
    this.opts = {
      windowSeconds: opts.windowSeconds ?? 10,
      backgroundColor: opts.backgroundColor ?? '#0d162a',
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
    const nowSec = performance.now() / 1000;
    if (this.timeOffsetSec === null) {
      this.timeOffsetSec = nowSec - (frame.t / 1000);
    }

    const tSec = (frame.t / 1000) + this.timeOffsetSec;
    this.samples.push({
      tSec,
      midi: frame.midi,
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

  clear(): void {
    this.samples = [];
    this.timeOffsetSec = null;
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
    this.drawTrace(nowSec, plotLeft, plotWidth, height);
  }

  private drawKeyboardScale(plotLeft: number, height: number): void {
    this.ctx.fillStyle = '#0a0f1c';
    this.ctx.fillRect(0, 0, plotLeft, height);

    const lines = buildSemitoneGrid();
    for (const line of lines) {
      if (!line.isBlackKey) continue;
      const topY = midiToGraphY(line.midi + 0.5, height);
      const bottomY = midiToGraphY(line.midi - 0.5, height);
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
    const lines = buildSemitoneGrid();
    for (const line of lines) {
      const y = midiToGraphY(line.midi, height);
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
      const y1 = midiToGraphY(prev.midi, height);
      const x2 = plotLeft + timeToGraphX(next.tSec, nowSec, plotWidth, this.opts.windowSeconds);
      const y2 = midiToGraphY(next.midi, height);

      this.ctx.strokeStyle = this.cssColor(next.color);
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }
  }

  private cssColor(color: GraphTraceColor): string {
    if (color === 'green') return '#4caf50';
    if (color === 'red') return '#ef5350';
    return '#9e9e9e';
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
}
