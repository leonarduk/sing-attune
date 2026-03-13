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
  label: string | null;
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
    const octave = Math.floor(midi / 12) - 1;
    lines.push({ midi, isOctave, label: isOctave ? `C${octave}` : null });
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

    this.ctx.fillStyle = this.opts.backgroundColor;
    this.ctx.fillRect(0, 0, width, height);

    this.drawYGrid(width, height);
    this.drawXGrid(nowSec, width, height);
    this.drawTrace(nowSec, width, height);
  }

  private drawYGrid(width: number, height: number): void {
    const lines = buildSemitoneGrid();
    for (const line of lines) {
      const y = midiToGraphY(line.midi, height);
      this.ctx.strokeStyle = line.isOctave ? 'rgba(168, 190, 220, 0.45)' : 'rgba(168, 190, 220, 0.15)';
      this.ctx.lineWidth = line.isOctave ? 1.5 : 1;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();

      if (line.label) {
        this.ctx.fillStyle = '#c6d8f3';
        this.ctx.font = '12px system-ui, sans-serif';
        this.ctx.fillText(line.label, 6, y - 2);
      }
    }
  }

  private drawXGrid(nowSec: number, width: number, height: number): void {
    const newestWhole = Math.floor(nowSec);
    const oldest = nowSec - this.opts.windowSeconds;

    this.ctx.strokeStyle = 'rgba(240, 240, 255, 0.15)';
    this.ctx.lineWidth = 1;

    for (let sec = newestWhole; sec >= oldest; sec -= 1) {
      const x = timeToGraphX(sec, nowSec, width, this.opts.windowSeconds);
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
  }

  private drawTrace(nowSec: number, width: number, height: number): void {
    if (this.samples.length < 2) return;

    this.ctx.lineWidth = 2;

    for (let i = 1; i < this.samples.length; i += 1) {
      const prev = this.samples[i - 1];
      const next = this.samples[i];

      const x1 = timeToGraphX(prev.tSec, nowSec, width, this.opts.windowSeconds);
      const y1 = midiToGraphY(prev.midi, height);
      const x2 = timeToGraphX(next.tSec, nowSec, width, this.opts.windowSeconds);
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
