import { describe, expect, it } from 'vitest';
import {
  buildPitchGraphAriaLabel,
  buildSemitoneGrid,
  DEFAULT_BAND_CENTS_TOLERANCE,
  GRAPH_MIDI_MAX,
  GRAPH_MIDI_MIN,
  midiToGraphY,
  pruneSamples,
  targetBandY,
  timeToGraphX,
  traceLineDash,
} from './graph';
import { classifyGraphTraceColor, centsError, GRAPH_IN_TUNE_CENTS } from './graph-colors';



describe('pitch graph accessibility label', () => {
  it('describes note range and rolling time window', () => {
    expect(buildPitchGraphAriaLabel(36, 84, 10)).toBe(
      'Real-time pitch graph showing your sung pitch (C2–C6) over a 10-second rolling window',
    );
  });
});
describe('graph coordinate helpers', () => {
  it('maps midi bounds to canvas bounds', () => {
    expect(midiToGraphY(GRAPH_MIDI_MAX, 100)).toBe(0);
    expect(midiToGraphY(GRAPH_MIDI_MIN, 100)).toBe(100);
  });

  it('maps time in window to x positions', () => {
    expect(timeToGraphX(100, 100, 400, 10)).toBe(400);
    expect(timeToGraphX(90, 100, 400, 10)).toBe(0);
  });

  it('prunes samples older than cutoff', () => {
    const remaining = pruneSamples([
      { tSec: 10, midi: 60, expectedMidi: null, color: 'grey' },
      { tSec: 15, midi: 61, expectedMidi: 60, color: 'green' },
    ], 12);

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tSec).toBe(15);
  });
});

describe('graph color classification', () => {
  it('returns grey when no target exists', () => {
    expect(classifyGraphTraceColor(60, null)).toBe('grey');
  });

  it('respects ±50 cents in-tune threshold', () => {
    expect(GRAPH_IN_TUNE_CENTS).toBe(50);
    expect(classifyGraphTraceColor(60.5, 60)).toBe('green');
    expect(classifyGraphTraceColor(60.51, 60)).toBe('red');
    expect(Math.round(centsError(60.51, 60))).toBe(51);
  });
});

describe('semitone grid derivation', () => {
  it('includes C2..C6 with natural-note labels and black-key flags', () => {
    const lines = buildSemitoneGrid();
    expect(lines[0]?.midi).toBe(GRAPH_MIDI_MIN);
    expect(lines.at(-1)?.midi).toBe(GRAPH_MIDI_MAX);

    const labels = lines.filter((line) => line.label !== null).map((line) => line.label);
    expect(labels).toContain('C2');
    expect(labels).toContain('A4');
    expect(labels).toContain('C6');

    const sharpLabels = lines.filter((line) => line.label?.includes('#'));
    expect(sharpLabels).toHaveLength(0);

    const firstSharp = lines.find((line) => line.midi === 37);
    expect(firstSharp?.isBlackKey).toBe(true);
  });
});

describe('targetBandY', () => {
  it('has a default tolerance of 50 cents', () => {
    expect(DEFAULT_BAND_CENTS_TOLERANCE).toBe(50);
  });

  it('returns topY < bottomY (canvas Y increases downward)', () => {
    const { topY, bottomY } = targetBandY(60, 50, 1000);
    expect(topY).toBeLessThan(bottomY);
  });

  it('band is symmetric around the expected note centre line', () => {
    const height = 1000;
    const midi = 60;
    const centreY = midiToGraphY(midi, height);
    const { topY, bottomY } = targetBandY(midi, 50, height);
    expect(centreY - topY).toBeCloseTo(bottomY - centreY, 0);
  });

  it('wider tolerance produces a taller band', () => {
    const narrow = targetBandY(60, 25, 1000);
    const wide = targetBandY(60, 100, 1000);
    expect(wide.bottomY - wide.topY).toBeGreaterThan(narrow.bottomY - narrow.topY);
  });

  it('band height corresponds to 2 × tolerance cents in MIDI space', () => {
    const height = 10000; // large canvas for precision
    const cents = 50;
    const { topY, bottomY } = targetBandY(60, cents, height);
    const bandHeightPx = bottomY - topY;
    // 1 semitone = 100 cents; range is GRAPH_MIDI_MAX - GRAPH_MIDI_MIN semitones
    const pixelsPerSemitone = height / (GRAPH_MIDI_MAX - GRAPH_MIDI_MIN);
    const expectedHeightPx = (2 * cents / 100) * pixelsPerSemitone;
    expect(bandHeightPx).toBeCloseTo(expectedHeightPx, 1);
  });
});


describe('traceLineDash', () => {
  it('uses solid, dashed, and dotted line styles for accessibility', () => {
    expect(traceLineDash('green')).toEqual([]);
    expect(traceLineDash('red')).toEqual([7, 4]);
    expect(traceLineDash('grey')).toEqual([2, 4]);
  });
});
