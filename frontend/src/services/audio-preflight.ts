import {
  DEFAULT_PLAYBACK_INSTRUMENT_ID,
  PLAYBACK_INSTRUMENTS,
  type PlaybackInstrumentId,
} from '../playback/soundfont';

const PRE_FLIGHT_DEVICE_KEY = 'sing-attune.preflight.deviceId';
const PRE_FLIGHT_LATENCY_KEY = 'sing-attune.preflight.latencyMs';
const USER_VOICE_TYPE_KEY = 'userVoiceType';
const USER_OCTAVE_COMP_KEY = 'sing-attune.preflight.octaveCompensation';
const PLAYBACK_VOICE_KEY = 'sing-attune.preflight.playbackVoice';

const DEFAULT_LATENCY_MS = 0;

let openPreflightModal: (() => Promise<boolean>) | null = null;
let preflightCompleted = false;
// #650: mirrors pitch-overlay's "Synthetic pitch input (no WebSocket)" checkbox
// state here (a services module) rather than having audio-preflight import
// pitch-overlay directly, which would create a cycle (pitch-overlay already
// imports loadUserVoiceTypeId from this module). The audio-preflight modal
// reads this to decide whether "Start rehearsal" may bypass the real
// microphone permission gate — synthetic mode replaces the mic entirely, so
// gating on browser mic permission would defeat the setting's documented
// purpose of letting the app be exercised without a working microphone.
let syntheticPitchInputEnabled = false;

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function registerAudioPreflightOpener(opener: () => Promise<boolean>): void {
  openPreflightModal = opener;
}

export function markAudioPreflightComplete(): void {
  preflightCompleted = true;
}

export function isSyntheticPitchInputEnabled(): boolean {
  return syntheticPitchInputEnabled;
}

export function setSyntheticPitchInputEnabled(enabled: boolean): void {
  syntheticPitchInputEnabled = enabled;
}

export async function ensureAudioPreflightReady(): Promise<boolean> {
  if (preflightCompleted) return true;
  if (!openPreflightModal) return false;
  const completed = await openPreflightModal();
  if (completed) preflightCompleted = true;
  return completed;
}

export function loadPreflightDeviceId(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  const value = storage.getItem(PRE_FLIGHT_DEVICE_KEY);
  return value && value.trim() !== '' ? value : null;
}

export function persistPreflightDeviceId(deviceId: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  if (!deviceId) {
    storage.removeItem(PRE_FLIGHT_DEVICE_KEY);
    return;
  }
  storage.setItem(PRE_FLIGHT_DEVICE_KEY, deviceId);
}

export function loadPreflightLatencyMs(): number {
  const storage = getStorage();
  if (!storage) return DEFAULT_LATENCY_MS;
  const raw = storage.getItem(PRE_FLIGHT_LATENCY_KEY);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LATENCY_MS;
  return Math.min(500, Math.max(-250, parsed));
}

export function persistPreflightLatencyMs(value: number): void {
  const storage = getStorage();
  if (!storage) return;
  const clamped = Math.round(Math.min(500, Math.max(-250, value)));
  storage.setItem(PRE_FLIGHT_LATENCY_KEY, String(clamped));
}

export function loadUserVoiceTypeId(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  const value = storage.getItem(USER_VOICE_TYPE_KEY);
  return value && value.trim() !== '' ? value : null;
}

export function persistUserVoiceTypeId(voiceTypeId: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  if (!voiceTypeId) {
    storage.removeItem(USER_VOICE_TYPE_KEY);
    return;
  }
  storage.setItem(USER_VOICE_TYPE_KEY, voiceTypeId);
}

/**
 * Playback voice (GM instrument used for score playback). Defaults to a
 * vocal timbre — see soundfont.ts's DEFAULT_PLAYBACK_INSTRUMENT_ID — rather
 * than piano, per #361 (piano playback is much less useful for singing
 * practice than a vocal-ish timbre).
 */
export function loadPlaybackVoiceId(): PlaybackInstrumentId {
  const storage = getStorage();
  const stored = storage?.getItem(PLAYBACK_VOICE_KEY) ?? null;
  const match = PLAYBACK_INSTRUMENTS.find((option) => option.id === stored);
  return match ? match.id : DEFAULT_PLAYBACK_INSTRUMENT_ID;
}

export function persistPlaybackVoiceId(instrumentId: PlaybackInstrumentId): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(PLAYBACK_VOICE_KEY, instrumentId);
}

export function loadOctaveCompensationEnabled(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  return storage.getItem(USER_OCTAVE_COMP_KEY) === '1';
}

export function persistOctaveCompensationEnabled(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(USER_OCTAVE_COMP_KEY, enabled ? '1' : '0');
}
