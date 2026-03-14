export interface PitchFrame {
  t: number;
  midi: number;
  conf: number;
}

export type PitchSocketMessage =
  | { kind: 'frame'; frame: PitchFrame }
  | { kind: 'status' }
  | { kind: 'ping' }
  | { kind: 'unknown' };

export const PITCH_RECONNECT_BASE_MS = 500;
export const PITCH_RECONNECT_MAX_MS = 5000;

export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 0) return PITCH_RECONNECT_BASE_MS;
  return Math.min(PITCH_RECONNECT_BASE_MS * (2 ** (attempt - 1)), PITCH_RECONNECT_MAX_MS);
}

export function parsePitchFrame(payload: unknown): PitchFrame | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const frame = payload as { t?: unknown; midi?: unknown; conf?: unknown };
  if (typeof frame.t !== 'number' || typeof frame.midi !== 'number' || typeof frame.conf !== 'number') {
    return null;
  }
  return { t: frame.t, midi: frame.midi, conf: frame.conf };
}

export function parsePitchSocketMessage(payload: unknown): PitchSocketMessage {
  if (typeof payload !== 'object' || payload === null) return { kind: 'unknown' };
  const message = payload as { status?: unknown; ping?: unknown };

  if (message.status === 'connected') {
    return { kind: 'status' };
  }
  if (message.ping === true) {
    return { kind: 'ping' };
  }

  const frame = parsePitchFrame(payload);
  if (frame) {
    return { kind: 'frame', frame };
  }

  return { kind: 'unknown' };
}
