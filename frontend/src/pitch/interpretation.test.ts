import { describe, expect, it } from 'vitest';
import {
  createPitchInterpreter,
  GREEN_ENTRY_CENTS,
  GREEN_EXIT_CENTS,
  MEDIAN_FILTER_FRAMES,
  ONSET_SETTLE_MS,
  noteKey,
} from './interpretation';

describe('PitchInterpreter', () => {
  const expectedMidi = 60;
  const expectedNoteKey = noteKey(0, expectedMidi, 'S');

  it('stabilizes pitch output with median filter and suppresses isolated octave spikes', () => {
    const interpreter = createPitchInterpreter();
    const out: number[] = [];
    const input = [60, 60.02, 60.03, 72, 59.99, 60.01, 60.04];

    input.forEach((midi, idx) => {
      const frame = interpreter.processFrame({
        t: ONSET_SETTLE_MS + idx * 20,
        midi,
        conf: 0.9,
        expectedMidi,
        expectedNoteKey,
        confidenceThreshold: 0.6,
      });
      out.push(frame.filteredMidi);
    });

    expect(out[3]).toBeLessThan(61);
    expect(out[out.length - 1]).toBeGreaterThan(59.9);
    expect(out[out.length - 1]).toBeLessThan(60.1);
  });

  it('uses grey during onset settling, then resumes grading', () => {
    const interpreter = createPitchInterpreter();

    const first = interpreter.processFrame({ t: 0, midi: 60, conf: 0.95, expectedMidi, expectedNoteKey, confidenceThreshold: 0.6 });
    const second = interpreter.processFrame({ t: ONSET_SETTLE_MS - 1, midi: 60, conf: 0.95, expectedMidi, expectedNoteKey, confidenceThreshold: 0.6 });
    const third = interpreter.processFrame({ t: ONSET_SETTLE_MS, midi: 60, conf: 0.95, expectedMidi, expectedNoteKey, confidenceThreshold: 0.6 });

    expect(first.color).toBe('grey');
    expect(second.color).toBe('grey');
    expect(third.color).toBe('green');
  });

  it('applies green hysteresis entry/exit thresholds', () => {
    const interpreter = createPitchInterpreter();
    interpreter.processFrame({
      t: 0,
      midi: expectedMidi + (GREEN_ENTRY_CENTS / 100) + 0.05,
      conf: 0.95,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    });

    const atAmber = interpreter.processFrame({
      t: ONSET_SETTLE_MS,
      midi: expectedMidi + (GREEN_ENTRY_CENTS / 100) + 0.05,
      conf: 0.95,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    });

    const enterGreen = Array.from({ length: MEDIAN_FILTER_FRAMES }).map((_, idx) => interpreter.processFrame({
      t: ONSET_SETTLE_MS + 20 + idx * 20,
      midi: expectedMidi,
      conf: 0.95,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    }));

    const stayGreen = interpreter.processFrame({
      t: ONSET_SETTLE_MS + 140,
      midi: expectedMidi + (GREEN_EXIT_CENTS / 100),
      conf: 0.95,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    });

    const exitGreen = Array.from({ length: MEDIAN_FILTER_FRAMES }).map((_, idx) => interpreter.processFrame({
      t: ONSET_SETTLE_MS + 160 + idx * 20,
      midi: expectedMidi + (GREEN_EXIT_CENTS / 100) + 0.1,
      conf: 0.95,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    }));

    expect(atAmber.color).toBe('amber');
    expect(enterGreen.at(-1)?.color).toBe('green');
    expect(stayGreen.color).toBe('green');
    expect(exitGreen.at(-1)?.color).toBe('amber');
  });

  it('retains voiced history through low-confidence frames and resets explicitly', () => {
    const interpreter = createPitchInterpreter();
    const inputs = [60, 60.02, 59.98, 60.01, 60.03];

    inputs.forEach((midi, idx) => {
      interpreter.processFrame({
        t: ONSET_SETTLE_MS + idx * 15,
        midi,
        conf: 0.9,
        expectedMidi,
        expectedNoteKey,
        confidenceThreshold: 0.6,
      });
    });

    const lowConf = interpreter.processFrame({
      t: ONSET_SETTLE_MS + 100,
      midi: 62,
      conf: 0.3,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    });
    expect(lowConf.color).toBe('grey');
    expect(lowConf.filteredMidi).toBeGreaterThan(59.95);
    expect(lowConf.filteredMidi).toBeLessThan(60.05);

    interpreter.reset();
    const afterReset = interpreter.processFrame({
      t: ONSET_SETTLE_MS + 120,
      midi: 62,
      conf: 0.9,
      expectedMidi,
      expectedNoteKey,
      confidenceThreshold: 0.6,
    });

    expect(afterReset.filteredMidi).toBe(62);
    expect(MEDIAN_FILTER_FRAMES).toBe(5);
  });
});
