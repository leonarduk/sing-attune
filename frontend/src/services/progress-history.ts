export interface PracticeSessionSummary {
  id: string;
  timestamp: string;
  pieceName: string;
  part: string;
  minMidi: number | null;
  maxMidi: number | null;
  averageConfidence: number;
  singingDurationMs: number;
}

interface ActiveCapture {
  timestamp: string;
  pieceName: string;
  part: string;
  minMidi: number | null;
  maxMidi: number | null;
  confidenceSum: number;
  confidenceCount: number;
  singingDurationMs: number;
  lastFrameTMs: number | null;
}

const STORAGE_KEY = 'sing-attune.progress-history.v1';
const MAX_SAVED_SESSIONS = 250;
const MAX_FRAME_GAP_MS = 2000;
const DEFAULT_FRAME_DURATION_MS = 100;
/** Frames below this confidence are excluded from range and average stats. */
const MIN_VOICED_CONFIDENCE = 0.5;

let activeCapture: ActiveCapture | null = null;
const listeners = new Set<(sessions: PracticeSessionSummary[]) => void>();
const memoryStorage = new Map<string, string>();

function getStoredRaw(): string | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return memoryStorage.get(STORAGE_KEY) ?? null;
  }
  return window.localStorage.getItem(STORAGE_KEY);
}

function setStoredRaw(value: string): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    memoryStorage.set(STORAGE_KEY, value);
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // QuotaExceededError — fall back to in-memory so listeners still fire.
    memoryStorage.set(STORAGE_KEY, value);
  }
}

function parseStoredSessions(raw: string | null): PracticeSessionSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PracticeSessionSummary => (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as PracticeSessionSummary).id === 'string' &&
      typeof (entry as PracticeSessionSummary).timestamp === 'string' &&
      typeof (entry as PracticeSessionSummary).pieceName === 'string' &&
      typeof (entry as PracticeSessionSummary).part === 'string' &&
      (typeof (entry as PracticeSessionSummary).minMidi === 'number' || (entry as PracticeSessionSummary).minMidi === null) &&
      (typeof (entry as PracticeSessionSummary).maxMidi === 'number' || (entry as PracticeSessionSummary).maxMidi === null) &&
      typeof (entry as PracticeSessionSummary).averageConfidence === 'number' &&
      typeof (entry as PracticeSessionSummary).singingDurationMs === 'number'
    ));
  } catch {
    return [];
  }
}

function writeSessions(sessions: PracticeSessionSummary[]): void {
  setStoredRaw(JSON.stringify(sessions));
  for (const listener of listeners) listener(sessions);
}

export function loadPracticeHistory(): PracticeSessionSummary[] {
  return parseStoredSessions(getStoredRaw());
}

export function subscribePracticeHistory(listener: (sessions: PracticeSessionSummary[]) => void): () => void {
  listeners.add(listener);
  listener(loadPracticeHistory());
  return () => { listeners.delete(listener); };
}

export function startPracticeSessionCapture(pieceName: string, part: string, timestamp = new Date()): void {
  if (activeCapture) return;
  activeCapture = {
    timestamp: timestamp.toISOString(),
    pieceName,
    part,
    minMidi: null,
    maxMidi: null,
    confidenceSum: 0,
    confidenceCount: 0,
    singingDurationMs: 0,
    lastFrameTMs: null,
  };
}

export function capturePitchFrame(frame: { t: number; midi: number; conf: number }): void {
  if (!activeCapture) return;

  // Always accumulate duration (regardless of voicing quality) so wall time is
  // tracked even through quiet passages.
  if (activeCapture.lastFrameTMs === null) {
    activeCapture.singingDurationMs += DEFAULT_FRAME_DURATION_MS;
  } else if (frame.t >= activeCapture.lastFrameTMs) {
    const delta = frame.t - activeCapture.lastFrameTMs;
    if (delta <= MAX_FRAME_GAP_MS) activeCapture.singingDurationMs += delta;
  }
  activeCapture.lastFrameTMs = frame.t;

  // Only include sufficiently confident (voiced) frames in pitch range and
  // average confidence stats to avoid unvoiced noise corrupting the summary.
  if (frame.conf < MIN_VOICED_CONFIDENCE) return;
  activeCapture.minMidi = activeCapture.minMidi === null ? frame.midi : Math.min(activeCapture.minMidi, frame.midi);
  activeCapture.maxMidi = activeCapture.maxMidi === null ? frame.midi : Math.max(activeCapture.maxMidi, frame.midi);
  activeCapture.confidenceSum += frame.conf;
  activeCapture.confidenceCount += 1;
}

export function finishPracticeSessionCapture(): PracticeSessionSummary | null {
  if (!activeCapture) return null;
  const complete: PracticeSessionSummary = {
    id: crypto.randomUUID(),
    timestamp: activeCapture.timestamp,
    pieceName: activeCapture.pieceName,
    part: activeCapture.part,
    minMidi: activeCapture.minMidi,
    maxMidi: activeCapture.maxMidi,
    averageConfidence: activeCapture.confidenceCount > 0
      ? activeCapture.confidenceSum / activeCapture.confidenceCount
      : 0,
    singingDurationMs: activeCapture.singingDurationMs,
  };
  activeCapture = null;

  const existing = loadPracticeHistory();
  writeSessions([complete, ...existing].slice(0, MAX_SAVED_SESSIONS));
  return complete;
}

export function clearPracticeHistory(): void {
  activeCapture = null;
  writeSessions([]);
}

export function exportPracticeHistory(): string {
  return JSON.stringify(loadPracticeHistory(), null, 2);
}
