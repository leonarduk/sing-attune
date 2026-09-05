export interface PitchFrame {
  t: number;
  midi: number;
  conf: number;
}

export interface PitchFrameV1 extends PitchFrame {
  v: 1;
}

export type PitchSocketMessage =
  | { kind: 'frame'; frame: PitchFrameV1 }
  | { kind: 'status' }
  | { kind: 'ping' }
  | { kind: 'unknown' };

export const PITCH_RECONNECT_BASE_MS = 500;
export const PITCH_RECONNECT_MAX_MS = 5000;
export const PITCH_FRAME_PROTOCOL_VERSION = 1 as const;

export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 0) return PITCH_RECONNECT_BASE_MS;
  return Math.min(PITCH_RECONNECT_BASE_MS * (2 ** (attempt - 1)), PITCH_RECONNECT_MAX_MS);
}

// This function's range/finiteness checks satisfy #440's AC #4 — they
// landed here via the unrelated protocol-versioning change (#378, see
// `v: PITCH_FRAME_PROTOCOL_VERSION` above) before #440 was filed, so #440's
// own diff doesn't add them, just documents that they already exist below.
export function parsePitchFrame(payload: unknown): PitchFrameV1 | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const frame = payload as { v?: unknown; t?: unknown; midi?: unknown; conf?: unknown };
  if (
    frame.v !== PITCH_FRAME_PROTOCOL_VERSION
    // #440 AC #4: t must be a finite, non-negative number
    || typeof frame.t !== 'number' || !Number.isFinite(frame.t) || frame.t < 0
    // #440 AC #4: midi must be a finite number in the 0-127 MIDI range
    || typeof frame.midi !== 'number' || !Number.isFinite(frame.midi) || frame.midi < 0 || frame.midi > 127
    // #440 AC #4: conf must be a finite number in the 0-1 confidence range
    || typeof frame.conf !== 'number' || !Number.isFinite(frame.conf) || frame.conf < 0 || frame.conf > 1
  ) {
    return null;
  }
  return { v: PITCH_FRAME_PROTOCOL_VERSION, t: frame.t, midi: frame.midi, conf: frame.conf };
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
