import { expectedNoteAtBeat } from '../pitch/accuracy';
import { elapsedToBeat } from '../score/timing';
import type { NoteModel, TempoMark } from '../score/renderer';

export interface SessionFrame {
  t: number;
  beat: number;
  midi: number | null;
  conf: number;
  expected_midi: number | null;
  measure: number | null;
}

interface SessionContext {
  title: string;
  part: string;
  tempoMarks: TempoMark[];
  notes: NoteModel[];
}

let enabled = false;
let context: SessionContext | null = null;
let frames: SessionFrame[] = [];

export function setSessionRecordingEnabled(value: boolean): void {
  enabled = value;
}

export function isSessionRecordingEnabled(): boolean {
  return enabled;
}

export function startSessionRecording(nextContext: SessionContext): void {
  if (!enabled) return;
  context = nextContext;
  frames = [];
}

export function recordSessionFrame(frame: { t: number; midi: number; conf: number }): void {
  if (!enabled || !context) return;

  const beat = elapsedToBeat(frame.t, 0, context.tempoMarks);
  const expected = expectedNoteAtBeat(beat, context.notes);
  frames.push({
    t: frame.t,
    beat,
    midi: frame.midi,
    conf: frame.conf,
    expected_midi: expected?.midi ?? null,
    measure: expected?.measure ?? null,
  });
}

export function stopSessionRecording(): { title: string; part: string; created_at: string; frames: SessionFrame[] } | null {
  if (!enabled || !context || frames.length === 0) {
    context = null;
    frames = [];
    return null;
  }

  const payload = {
    title: context.title,
    part: context.part,
    created_at: new Date().toISOString(),
    frames: [...frames],
  };

  context = null;
  frames = [];
  return payload;
}

export function buildSessionCsv(session: { frames: SessionFrame[] }): string {
  const lines = ['beat,expected_midi,sung_midi,cents_deviation'];
  for (const frame of session.frames) {
    const sung = frame.midi;
    const expected = frame.expected_midi;
    const cents = sung !== null && expected !== null ? ((sung - expected) * 100).toFixed(2) : '';
    lines.push(`${frame.beat.toFixed(4)},${expected ?? ''},${sung ?? ''},${cents}`);
  }
  return lines.join('\n');
}

export function sessionStats(session: { frames: SessionFrame[] }): {
  within50Pct: number;
  within100Pct: number;
  worstMeasure: number | null;
} {
  const aligned = session.frames.filter((frame) => frame.midi !== null && frame.expected_midi !== null);
  if (aligned.length === 0) {
    return { within50Pct: 0, within100Pct: 0, worstMeasure: null };
  }

  const within50 = aligned.filter((frame) => Math.abs((frame.midi as number) - (frame.expected_midi as number)) <= 0.5).length;
  const within100 = aligned.filter((frame) => Math.abs((frame.midi as number) - (frame.expected_midi as number)) <= 1.0).length;

  const byMeasure = new Map<number, { total: number; count: number }>();
  for (const frame of aligned) {
    if (frame.measure === null) continue;
    const deviation = Math.abs(((frame.midi as number) - (frame.expected_midi as number)) * 100);
    const item = byMeasure.get(frame.measure) ?? { total: 0, count: 0 };
    item.total += deviation;
    item.count += 1;
    byMeasure.set(frame.measure, item);
  }

  let worstMeasure: number | null = null;
  let worstAvg = -1;
  for (const [measure, item] of byMeasure.entries()) {
    const avg = item.total / item.count;
    if (avg > worstAvg) {
      worstAvg = avg;
      worstMeasure = measure;
    }
  }

  return {
    within50Pct: (within50 / aligned.length) * 100,
    within100Pct: (within100 / aligned.length) * 100,
    worstMeasure,
  };
}
