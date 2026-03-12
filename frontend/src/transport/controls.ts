import { beatToSeconds } from '../playback/engine';
import type { ScoreModel } from '../score/renderer';

export async function postPlayback(path: '/playback/start' | '/playback/pause' | '/playback/resume' | '/playback/stop'): Promise<void> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: ${path} (HTTP ${res.status})`);
}

export async function seekPlayback(tMs: number): Promise<void> {
  const res = await fetch(`/playback/seek?t_ms=${encodeURIComponent(tMs.toFixed(1))}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: /playback/seek (HTTP ${res.status})`);
}

export function beatToMs(beat: number, scoreModel: ScoreModel, tempoMultiplier: number): number {
  return beatToSeconds(beat, scoreModel.tempo_marks, tempoMultiplier) * 1000;
}
