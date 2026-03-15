import { GREEN_CENTS_THRESHOLD } from './accuracy';

export type GraphTraceColor = 'green' | 'red' | 'grey';

/**
 * Graph trace uses the same in-tune threshold as the score dot/phrase summary
 * so all pitch feedback surfaces remain visually consistent for singers.
 */
export const GRAPH_IN_TUNE_CENTS = GREEN_CENTS_THRESHOLD;

export function centsError(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

export function classifyGraphTraceColor(sungMidi: number, expectedMidi: number | null): GraphTraceColor {
  if (expectedMidi === null) return 'grey';
  return Math.abs(centsError(sungMidi, expectedMidi)) <= GRAPH_IN_TUNE_CENTS ? 'green' : 'red';
}
