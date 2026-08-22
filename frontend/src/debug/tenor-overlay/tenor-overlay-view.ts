/**
 * Canvas overlay for the tenor bass-clef / transposed-treble comparison
 * debug view (#360).
 *
 * Deliberately reuses frontend/src/pitch/graph.ts's drawing primitives
 * (buildSemitoneGrid, midiToGraphY, traceLineDash) rather than re-deriving
 * pitch-grid math — see #360's instruction to reuse the existing pitch-graph
 * primitives instead of writing a new renderer. The one thing graph.ts does
 * NOT provide is a beat-axis (it only knows real-time rolling-window
 * seconds), so the beat→x mapping here is the minimal addition needed for a
 * static, non-real-time overlay.
 */
import { buildSemitoneGrid, GRAPH_MIDI_MAX, GRAPH_MIDI_MIN, midiToGraphY, traceLineDash } from '../../pitch/graph';
import type { OverlayComparisonResult, OverlayNote } from '../../pitch/tenor-overlay-compare';

const BASS_COLOR = '#39d98a'; // reuses the graph's "in tune" green
const TREBLE_COLOR = '#5aa9ff';
const MISMATCH_COLOR = '#ff5d5d';
const MARGIN_PX = { top: 16, right: 16, bottom: 28, left: 56 };

export interface TenorOverlayRenderInput {
  bassNotes: OverlayNote[];
  trebleNotes: OverlayNote[];
  comparison: OverlayComparisonResult;
  partName: string;
  startBar: number;
  endBar: number;
}

function beatExtent(notes: OverlayNote[][]): { minBeat: number; maxBeat: number } {
  const allBeats = notes.flat().map((n) => n.beat_start);
  if (allBeats.length === 0) return { minBeat: 0, maxBeat: 1 };
  const minBeat = Math.min(...allBeats);
  const maxBeat = Math.max(...allBeats);
  return { minBeat, maxBeat: maxBeat > minBeat ? maxBeat : minBeat + 1 };
}

function midiExtentFrom(notes: OverlayNote[][]): { minMidi: number; maxMidi: number } {
  const allMidis = notes.flat().map((n) => n.midi);
  if (allMidis.length === 0) return { minMidi: GRAPH_MIDI_MIN, maxMidi: GRAPH_MIDI_MAX };
  // A few semitones of padding keeps the trace off the plot edges.
  const padding = 3;
  return {
    minMidi: Math.max(GRAPH_MIDI_MIN, Math.min(...allMidis) - padding),
    maxMidi: Math.min(GRAPH_MIDI_MAX, Math.max(...allMidis) + padding),
  };
}

export class TenorOverlayCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  destroy(): void {
    this.canvas.remove();
  }

  render(input: TenorOverlayRenderInput): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 320;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.canvas.setAttribute(
      'aria-label',
      `Overlay of ${input.partName} bass-clef and transposed-treble notation, bars ${input.startBar}-${input.endBar}`,
    );

    const { minMidi, maxMidi } = midiExtentFrom([input.bassNotes, input.trebleNotes]);
    const { minBeat, maxBeat } = beatExtent([input.bassNotes, input.trebleNotes]);

    const plotLeft = MARGIN_PX.left;
    const plotTop = MARGIN_PX.top;
    const plotWidth = Math.max(1, width - MARGIN_PX.left - MARGIN_PX.right);
    const plotHeight = Math.max(1, height - MARGIN_PX.top - MARGIN_PX.bottom);

    const beatToX = (beat: number): number =>
      plotLeft + ((beat - minBeat) / Math.max(1e-6, maxBeat - minBeat)) * plotWidth;
    const midiToY = (midi: number): number => plotTop + midiToGraphY(midi, plotHeight, minMidi, maxMidi);

    this.ctx.fillStyle = '#0d162a';
    this.ctx.fillRect(0, 0, width, height);

    this.drawYGrid(plotLeft, plotWidth, plotTop, plotHeight, minMidi, maxMidi);

    if (input.bassNotes.length === 0 && input.trebleNotes.length === 0) {
      this.drawEmptyState(width, height);
      return;
    }

    this.drawSeries(input.bassNotes, beatToX, midiToY, BASS_COLOR, traceLineDash('green'));
    this.drawSeries(input.trebleNotes, beatToX, midiToY, TREBLE_COLOR, traceLineDash('red'));
    this.drawMismatchMarkers(input, beatToX, midiToY);
    this.drawLegend(plotLeft, plotTop);
  }

  private drawYGrid(
    plotLeft: number,
    plotWidth: number,
    plotTop: number,
    plotHeight: number,
    minMidi: number,
    maxMidi: number,
  ): void {
    const lines = buildSemitoneGrid(Math.floor(minMidi), Math.ceil(maxMidi));
    for (const line of lines) {
      const y = plotTop + midiToGraphY(line.midi, plotHeight, minMidi, maxMidi);
      this.ctx.strokeStyle = line.isOctave ? 'rgba(168, 190, 220, 0.45)' : 'rgba(168, 190, 220, 0.15)';
      this.ctx.lineWidth = line.isOctave ? 1.5 : 1;
      this.ctx.beginPath();
      this.ctx.moveTo(plotLeft, y);
      this.ctx.lineTo(plotLeft + plotWidth, y);
      this.ctx.stroke();

      if (line.label) {
        this.ctx.fillStyle = '#c6d8f3';
        this.ctx.font = '11px system-ui, sans-serif';
        this.ctx.fillText(line.label, 4, y - 2);
      }
    }
  }

  private drawEmptyState(width: number, height: number): void {
    this.ctx.fillStyle = '#94a5c4';
    this.ctx.font = '13px system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('No notes found for this part and bar range.', width / 2, height / 2);
    this.ctx.textAlign = 'left';
  }

  private drawSeries(
    notes: OverlayNote[],
    beatToX: (beat: number) => number,
    midiToY: (midi: number) => number,
    color: string,
    dash: number[],
  ): void {
    if (notes.length === 0) return;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2.5;
    this.ctx.setLineDash(dash);
    this.ctx.beginPath();
    notes.forEach((noteEntry, i) => {
      const x = beatToX(noteEntry.beat_start);
      const y = midiToY(noteEntry.midi);
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    this.ctx.fillStyle = color;
    for (const noteEntry of notes) {
      const x = beatToX(noteEntry.beat_start);
      const y = midiToY(noteEntry.midi);
      this.ctx.beginPath();
      this.ctx.arc(x, y, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  /**
   * Highlights notes that differ by something other than the detected
   * constant offset (#360 AC) — drawn as a ring around both the bass and
   * treble points at that index.
   */
  private drawMismatchMarkers(
    input: TenorOverlayRenderInput,
    beatToX: (beat: number) => number,
    midiToY: (midi: number) => number,
  ): void {
    this.ctx.strokeStyle = MISMATCH_COLOR;
    this.ctx.lineWidth = 2;
    for (const delta of input.comparison.deltas) {
      if (delta.matchesOffset) continue;
      const bassNote = input.bassNotes[delta.index];
      const trebleNote = input.trebleNotes[delta.index];
      for (const noteEntry of [bassNote, trebleNote]) {
        const x = beatToX(noteEntry.beat_start);
        const y = midiToY(noteEntry.midi);
        this.ctx.beginPath();
        this.ctx.arc(x, y, 7, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }
  }

  private drawLegend(plotLeft: number, plotTop: number): void {
    const entries: Array<{ label: string; color: string; dash: number[] }> = [
      { label: 'Bass clef', color: BASS_COLOR, dash: traceLineDash('green') },
      { label: 'Transposed treble', color: TREBLE_COLOR, dash: traceLineDash('red') },
    ];

    let x = plotLeft + 4;
    const y = plotTop + 10;
    this.ctx.font = '12px system-ui, sans-serif';
    for (const entry of entries) {
      this.ctx.strokeStyle = entry.color;
      this.ctx.lineWidth = 2.5;
      this.ctx.setLineDash(entry.dash);
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(x + 24, y);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.fillStyle = '#dce7ff';
      this.ctx.fillText(entry.label, x + 30, y + 4);
      x += 30 + this.ctx.measureText(entry.label).width + 20;
    }
  }
}
