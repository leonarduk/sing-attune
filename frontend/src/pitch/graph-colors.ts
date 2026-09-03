import { GREEN_CENTS_THRESHOLD, MIN_CONFIDENCE_FOR_DOT } from './accuracy';

export type GraphTraceColor = 'green' | 'red' | 'grey';

/**
 * Graph trace uses the same in-tune threshold as the score dot/phrase summary
 * so all pitch feedback surfaces remain visually consistent for singers.
 */
export const GRAPH_IN_TUNE_CENTS = GREEN_CENTS_THRESHOLD;

export function centsError(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

/**
 * Classifies a sung-pitch sample for the rolling pitch graph trace.
 *
 * `conf`/`confidenceThreshold` gate low-confidence samples to 'grey' —
 * the same treatment PitchInterpreter.processFrame (overlay.ts) and
 * StablePitchTracker.push (diagnostics.ts) give them. The backend already
 * drops conf < 0.6 frames before dispatch (docs/sync-protocol.md), so this
 * gate rarely fires in practice; it exists as frontend-only defense-in-depth
 * so a future backend regression can't render as a clean, confident-looking
 * green/red line on the graph (issue #433).
 *
 * `conf` defaults to 1 so existing callers that only care about pitch
 * accuracy (e.g. tests) don't need to pass a confidence value.
 */
export function classifyGraphTraceColor(
  sungMidi: number,
  expectedMidi: number | null,
  conf = 1,
  confidenceThreshold = MIN_CONFIDENCE_FOR_DOT,
): GraphTraceColor {
  if (conf < confidenceThreshold) return 'grey';
  if (expectedMidi === null) return 'grey';
  return Math.abs(centsError(sungMidi, expectedMidi)) <= GRAPH_IN_TUNE_CENTS ? 'green' : 'red';
}
