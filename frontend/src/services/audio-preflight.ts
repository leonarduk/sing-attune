const PRE_FLIGHT_DEVICE_KEY = 'sing-attune.preflight.deviceId';
const PRE_FLIGHT_LATENCY_KEY = 'sing-attune.preflight.latencyMs';

const DEFAULT_LATENCY_MS = 0;

let openPreflightModal: (() => Promise<boolean>) | null = null;
let preflightCompleted = false;

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
