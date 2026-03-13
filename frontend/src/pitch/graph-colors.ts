export type GraphTraceColor = 'green' | 'red' | 'grey';

export const GRAPH_IN_TUNE_CENTS = 25;

export function centsError(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

export function classifyGraphTraceColor(sungMidi: number, expectedMidi: number | null): GraphTraceColor {
  if (expectedMidi === null) return 'grey';
  return Math.abs(centsError(sungMidi, expectedMidi)) <= GRAPH_IN_TUNE_CENTS ? 'green' : 'red';
}
