import type { PitchFrame } from './socket';

const SWEEP_MIN_MIDI = 48;
const SWEEP_MAX_MIDI = 72;

export function syntheticPitchFrameAt(nowSec: number, expectedMidi: number | null, tMs = nowSec * 1000): PitchFrame {
  const sweepMid = (SWEEP_MIN_MIDI + SWEEP_MAX_MIDI) / 2;
  const sweepAmp = (SWEEP_MAX_MIDI - SWEEP_MIN_MIDI) / 2;
  const sweepMidi = sweepMid + (Math.sin(nowSec * 0.55) * sweepAmp);

  const baseMidi = expectedMidi ?? sweepMidi;
  const phase = Math.floor(nowSec) % 4;
  const offset = phase < 2 ? 0.08 : 0.42;
  const wobble = Math.sin(nowSec * 7.3) * 0.03;

  return {
    t: tMs,
    midi: baseMidi + offset + wobble,
    conf: 0.95,
  };
}
