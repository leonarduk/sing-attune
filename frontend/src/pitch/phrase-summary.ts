import { elapsedToBeat } from '../score/timing';
import type { NoteModel, TempoMark } from '../score/renderer';
import { centsOffPitch, classifyByCents, isWithinTolerance, MIN_CONFIDENCE_FOR_SUMMARY } from './accuracy';
import { midiToNoteName } from './note-name';

export const PHRASE_GAP_THRESHOLD_BEATS = 0.75;
export const SUMMARY_CONFIDENCE_REFERENCE = 0.8;
export const MIN_NOTE_SAMPLES_FOR_STRONG_BADGE = 5;
export const MIN_NOTE_SAMPLES_FOR_BIAS = 8;
export const BIAS_MEAN_CENTS_THRESHOLD = 15;
export const BIAS_CONSISTENCY_THRESHOLD = 0.7;

export type NoteBadge = 'green' | 'amber' | 'red';
export type DirectionalBias = 'flat' | 'sharp' | 'neutral';

export interface PhraseSegment {
  id: number;
  startBeat: number;
  endBeat: number;
  notes: NoteModel[];
}

interface PhraseSample {
  tMs: number;
  noteIndex: number;
  confidence: number;
  deviationCents: number;
}

export interface PhraseNoteSummary {
  label: string;
  badge: NoteBadge;
  direction: DirectionalBias;
  meanCents: number;
  sampleCount: number;
}

export interface PhraseSummary {
  phraseId: number;
  withinTolerancePct: number;
  noteSummaries: PhraseNoteSummary[];
}

export function segmentPhrases(notes: NoteModel[], gapThresholdBeats = PHRASE_GAP_THRESHOLD_BEATS): PhraseSegment[] {
  if (notes.length === 0) return [];
  const sorted = [...notes].sort((a, b) => a.beat_start - b.beat_start);
  const phrases: PhraseSegment[] = [];

  let current: NoteModel[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const gap = next.beat_start - (prev.beat_start + prev.duration);
    if (gap >= gapThresholdBeats) {
      phrases.push(buildPhrase(phrases.length + 1, current));
      current = [next];
      continue;
    }
    current.push(next);
  }

  phrases.push(buildPhrase(phrases.length + 1, current));
  return phrases;
}

function buildPhrase(id: number, notes: NoteModel[]): PhraseSegment {
  const first = notes[0];
  const last = notes[notes.length - 1];
  return {
    id,
    startBeat: first.beat_start,
    endBeat: last.beat_start + last.duration,
    notes,
  };
}

function noteIndexAtBeat(beat: number, notes: NoteModel[]): number {
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (beat >= note.beat_start && beat < note.beat_start + note.duration) return i;
  }
  return -1;
}

function weightedIntervalMs(index: number, samples: PhraseSample[], defaultMs: number): number {
  if (index < samples.length - 1) {
    return Math.max(1, samples[index + 1].tMs - samples[index].tMs);
  }
  return defaultMs;
}

function median(values: number[]): number {
  if (values.length === 0) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function toBadge(samples: PhraseSample[]): NoteBadge {
  const bands = samples.map((sample) => classifyByCents(Math.abs(sample.deviationCents)));
  const green = bands.filter((band) => band === 'green').length;
  const amber = bands.filter((band) => band === 'amber').length;
  const red = bands.filter((band) => band === 'red').length;
  const total = Math.max(1, bands.length);

  if (green / total >= 0.6) return 'green';
  if (red / total >= 0.4) return 'red';
  if (amber / total >= 0.5) return 'amber';
  return red > green ? 'red' : 'amber';
}

function isExtremeOutlier(sample: PhraseSample): boolean {
  return Math.abs(sample.deviationCents) >= 130;
}

function toDirection(samples: PhraseSample[]): DirectionalBias {
  if (samples.length < MIN_NOTE_SAMPLES_FOR_BIAS) return 'neutral';
  const mean = samples.reduce((sum, sample) => sum + sample.deviationCents, 0) / samples.length;
  if (Math.abs(mean) < BIAS_MEAN_CENTS_THRESHOLD) return 'neutral';

  const expectedSign = mean >= 0 ? 1 : -1;
  const sameSign = samples.filter((sample) => Math.sign(sample.deviationCents) === expectedSign).length;
  const consistency = sameSign / samples.length;
  if (consistency < BIAS_CONSISTENCY_THRESHOLD) return 'neutral';
  return mean < 0 ? 'flat' : 'sharp';
}

export class PhraseSummaryTracker {
  private readonly tempoMarks: TempoMark[];
  private readonly phrases: PhraseSegment[];
  private readonly samplesByPhrase = new Map<number, PhraseSample[]>();
  private nextPhraseIndex = 0;

  constructor(notes: NoteModel[], tempoMarks: TempoMark[]) {
    this.tempoMarks = tempoMarks;
    this.phrases = segmentPhrases(notes);
  }

  reset(): void {
    this.samplesByPhrase.clear();
    this.nextPhraseIndex = 0;
  }

  pushFrame(frame: { t: number; midi: number; conf: number }): PhraseSummary[] {
    if (this.phrases.length === 0) return [];

    const beat = elapsedToBeat(frame.t, 0, this.tempoMarks);
    while (this.nextPhraseIndex < this.phrases.length && beat >= this.phrases[this.nextPhraseIndex].endBeat) {
      this.nextPhraseIndex += 1;
    }

    const phrase = this.phrases.find((entry) => beat >= entry.startBeat && beat < entry.endBeat);
    if (!phrase) return this.drainCompleted(beat);

    const noteIndex = noteIndexAtBeat(beat, phrase.notes);
    if (noteIndex >= 0) {
      const expectedMidi = phrase.notes[noteIndex].midi;
      const sample: PhraseSample = {
        tMs: frame.t,
        noteIndex,
        confidence: frame.conf,
        deviationCents: centsOffPitch(frame.midi, expectedMidi),
      };
      const list = this.samplesByPhrase.get(phrase.id) ?? [];
      list.push(sample);
      this.samplesByPhrase.set(phrase.id, list);
    }

    return this.drainCompleted(beat);
  }

  private drainCompleted(currentBeat: number): PhraseSummary[] {
    const completed: PhraseSummary[] = [];
    for (const phrase of this.phrases) {
      if (phrase.endBeat > currentBeat) continue;
      if (!this.samplesByPhrase.has(phrase.id)) continue;
      const samples = this.samplesByPhrase.get(phrase.id) ?? [];
      completed.push(this.summarizePhrase(phrase, samples));
      this.samplesByPhrase.delete(phrase.id);
    }
    return completed;
  }

  private summarizePhrase(phrase: PhraseSegment, samples: PhraseSample[]): PhraseSummary {
    const qualifying = samples.filter((sample) => sample.confidence >= MIN_CONFIDENCE_FOR_SUMMARY);
    const intervals = qualifying.slice(1).map((sample, idx) => Math.max(1, sample.tMs - qualifying[idx].tMs));
    const defaultInterval = median(intervals);

    let weightedTotal = 0;
    let weightedInTolerance = 0;
    for (let i = 0; i < qualifying.length; i++) {
      const sample = qualifying[i];
      const intervalMs = weightedIntervalMs(i, qualifying, defaultInterval);
      const confidenceWeight = Math.max(0, Math.min(1, sample.confidence / SUMMARY_CONFIDENCE_REFERENCE));
      const weight = intervalMs * confidenceWeight;
      weightedTotal += weight;
      if (isWithinTolerance(Math.abs(sample.deviationCents))) {
        weightedInTolerance += weight;
      }
    }

    const noteSummaries: PhraseNoteSummary[] = phrase.notes.map((note, index) => {
      const noteSamples = qualifying.filter((sample) => sample.noteIndex === index);
      const meanCents = noteSamples.length === 0
        ? 0
        : noteSamples.reduce((sum, sample) => sum + sample.deviationCents, 0) / noteSamples.length;

      let badge = toBadge(noteSamples);
      const allExtreme = noteSamples.length > 0 && noteSamples.every(isExtremeOutlier);
      if (noteSamples.length < MIN_NOTE_SAMPLES_FOR_STRONG_BADGE && badge === 'red' && !allExtreme) {
        badge = 'amber';
      }

      return {
        label: midiToNoteName(note.midi),
        badge,
        direction: toDirection(noteSamples),
        meanCents,
        sampleCount: noteSamples.length,
      };
    });

    return {
      phraseId: phrase.id,
      withinTolerancePct: weightedTotal <= 0 ? 0 : (weightedInTolerance / weightedTotal) * 100,
      noteSummaries,
    };
  }
}
