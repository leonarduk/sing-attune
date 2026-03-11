/**
 * Pure timing utilities — no OSMD dependency.
 *
 * Extracted from ScoreCursor so the math can be unit tested without
 * a DOM or OSMD instance.
 */

import type { TempoMark } from './renderer';

/**
 * Convert milliseconds elapsed since playback started at `startBeat` to
 * beats elapsed, integrating across all tempo changes in `tempoMarks`.
 *
 * @param elapsedMs   Wall-clock ms since play() was called
 * @param startBeat   Beat position at which play() was called (quarter-note beats)
 * @param tempoMarks  Sorted ascending by beat; from ScoreModel.tempo_marks
 * @returns           Beats elapsed from startBeat (not absolute beat position)
 *
 * Coordinate system: beats are quarter-note beats throughout.
 * OSMD's currentTimeStamp.RealValue is in whole notes; multiply by 4 to convert.
 * This conversion is a unit definition, not a time-signature assumption.
 */
export function elapsedToBeat(
  elapsedMs: number,
  startBeat: number,
  tempoMarks: TempoMark[],
): number {
  if (tempoMarks.length === 0) {
    // No tempo information — assume 120 bpm (500 ms per beat)
    return elapsedMs / 500;
  }

  // Find the index of the tempo mark active at startBeat (last mark with beat <= startBeat)
  let idx = 0;
  for (let i = tempoMarks.length - 1; i >= 0; i--) {
    if (tempoMarks[i].beat <= startBeat) {
      idx = i;
      break;
    }
  }

  let remaining = elapsedMs;
  let beat = startBeat;

  for (let i = idx; remaining > 0; i++) {
    const bpm = tempoMarks[i]?.bpm ?? tempoMarks[tempoMarks.length - 1].bpm;
    const msPerBeat = 60_000 / bpm;
    const nextMarkBeat = tempoMarks[i + 1]?.beat;

    if (nextMarkBeat === undefined) {
      // Final (or only) tempo segment — all remaining ms at this tempo
      return beat + remaining / msPerBeat - startBeat;
    }

    const msToNextMark = (nextMarkBeat - beat) * msPerBeat;
    if (remaining <= msToNextMark) {
      return beat + remaining / msPerBeat - startBeat;
    }

    remaining -= msToNextMark;
    beat = nextMarkBeat;
  }

  return beat - startBeat;
}
