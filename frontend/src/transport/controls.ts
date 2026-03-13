import { beatToSeconds } from '../playback/engine';
import type { ScoreModel } from '../score/renderer';


export async function startPlayback(deviceId: number | null): Promise<void> {
  const query = deviceId === null ? '' : `?device_id=${encodeURIComponent(String(deviceId))}`;
  const res = await fetch(`/playback/start${query}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: /playback/start (HTTP ${res.status})`);
}

export async function postPlayback(path: string): Promise<void> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: ${path} (HTTP ${res.status})`);
}

export async function seekPlayback(tMs: number): Promise<void> {
  const res = await fetch(`/playback/seek?t_ms=${encodeURIComponent(tMs.toFixed(1))}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: /playback/seek (HTTP ${res.status})`);
}

export async function setPlaybackTempo(multiplier: number): Promise<void> {
  const res = await fetch(`/playback/tempo?multiplier=${encodeURIComponent(multiplier.toFixed(3))}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: /playback/tempo (HTTP ${res.status})`);
}

/**
 * Notify the backend of the active transposition offset.
 *
 * The frontend applies the same offset via PlaybackEngine.setTransposeSemitones()
 * which adjusts Web Audio detune. Calling this endpoint keeps the backend
 * pipeline in sync so the pitch interpretation layer (Day 9) can shift
 * expected MIDI targets when comparing detected f0 against score notes.
 *
 * @param semitones - Integer semitone offset, clamped to [-12, +12] server-side.
 */
export async function setPlaybackTranspose(semitones: number): Promise<void> {
  const res = await fetch(
    `/playback/transpose?semitones=${encodeURIComponent(Math.round(semitones))}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`Playback command failed: /playback/transpose (HTTP ${res.status})`);
}

/**
 * Convert a beat position to milliseconds using the score's tempo map.
 *
 * @param beat - Beat number relative to score start.
 * @param scoreModel - Score model containing the tempo mark array.
 * @param tempoMultiplier - Current playback speed multiplier (1.0 = normal).
 * @returns Elapsed milliseconds from beat 0 to the given beat.
 */
export function beatToMs(beat: number, scoreModel: ScoreModel, tempoMultiplier: number): number {
  return beatToSeconds(beat, scoreModel.tempo_marks, tempoMultiplier) * 1000;
}
