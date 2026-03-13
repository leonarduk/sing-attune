import { describe, expect, it } from 'vitest';
import { buildSemitoneGrid, GRAPH_MIDI_MAX, GRAPH_MIDI_MIN, midiToGraphY, pruneSamples, timeToGraphX } from './graph';
import { classifyGraphTraceColor, centsError, GRAPH_IN_TUNE_CENTS } from './graph-colors';

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
      { tSec: 10, midi: 60, color: 'grey' },
      { tSec: 15, midi: 61, color: 'green' },
    ], 12);

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tSec).toBe(15);
  });
});

describe('graph color classification', () => {
  it('returns grey when no target exists', () => {
    expect(classifyGraphTraceColor(60, null)).toBe('grey');
  });

  it('respects ±25 cents in-tune threshold', () => {
    expect(GRAPH_IN_TUNE_CENTS).toBe(25);
    expect(classifyGraphTraceColor(60.25, 60)).toBe('green');
    expect(classifyGraphTraceColor(60.26, 60)).toBe('red');
    expect(Math.round(centsError(60.26, 60))).toBe(26);
  });
});

describe('semitone grid derivation', () => {
  it('includes C2..C6 and octave labels', () => {
    const lines = buildSemitoneGrid();
    expect(lines[0]?.midi).toBe(GRAPH_MIDI_MIN);
    expect(lines.at(-1)?.midi).toBe(GRAPH_MIDI_MAX);

    const octaveLabels = lines.filter((line) => line.label !== null).map((line) => line.label);
    expect(octaveLabels).toEqual(['C2', 'C3', 'C4', 'C5', 'C6']);
  });
});
