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
  /** Monotonic high-water mark: the largest frame.t seen so far.
   *  Out-of-order frames (t < maxFrameTMs) are skipped for duration
   *  to avoid double-counting retransmits or jitter. */
  maxFrameTMs: number | null;
}

const STORAGE_KEY = 'sing-attune.progress-history.v1';
const MAX_SAVED_SESSIONS = 250;
const MAX_FRAME_GAP_MS = 2000;
const DEFAULT_FRAME_DURATION_MS = 100;
/** Sessions shorter than this are discarded as accidental button presses. */
const MIN_SESSION_DURATION_MS = 500;
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
    maxFrameTMs: null,
  };
}

export function capturePitchFrame(frame: { t: number; midi: number; conf: number }): void {
  if (!activeCapture) return;

  // Duration: advance only when frame.t moves the monotonic clock forward.
  // Out-of-order frames (t < maxFrameTMs) are retransmits or jitter —
  // skip them for duration to avoid double-counting elapsed time.
  if (activeCapture.maxFrameTMs === null) {
    // First frame: credit a nominal duration rather than zero.
    activeCapture.singingDurationMs += DEFAULT_FRAME_DURATION_MS;
  } else if (frame.t > activeCapture.maxFrameTMs) {
    const delta = frame.t - activeCapture.maxFrameTMs;
    if (delta <= MAX_FRAME_GAP_MS) activeCapture.singingDurationMs += delta;
    // delta > MAX_FRAME_GAP_MS: treat as a pause/resume gap — don't count it.
  }
  // Always advance the high-water mark forward; never move it back.
  if (activeCapture.maxFrameTMs === null || frame.t > activeCapture.maxFrameTMs) {
    activeCapture.maxFrameTMs = frame.t;
  }

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
  const capture = activeCapture;
  activeCapture = null;

  // Discard sessions that are too short to be meaningful (e.g. accidental
  // play→stop with no real singing, or stop fired before any frames arrived).
  if (capture.singingDurationMs < MIN_SESSION_DURATION_MS) return null;

  const complete: PracticeSessionSummary = {
    id: crypto.randomUUID(),
    timestamp: capture.timestamp,
    pieceName: capture.pieceName,
    part: capture.part,
    minMidi: capture.minMidi,
    maxMidi: capture.maxMidi,
    averageConfidence: capture.confidenceCount > 0
      ? capture.confidenceSum / capture.confidenceCount
      : 0,
    singingDurationMs: capture.singingDurationMs,
  };

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
