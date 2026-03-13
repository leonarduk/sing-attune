/**
 * Unit tests for PlaybackEngine timing math.
 *
 * beatToSeconds() is the inverse of elapsedToBeat() from timing.ts.
 * These tests verify correctness across single-tempo, multi-tempo, and
 * tempo-multiplier cases without requiring an AudioContext mock.
 */
import { describe, it, expect } from 'vitest';
import { beatToSeconds, PlaybackEngine } from './engine';
import { elapsedToBeat } from '../score/timing';

const BPM120: import('../score/renderer').TempoMark[] = [{ beat: 0, bpm: 120 }];
const BPM60: import('../score/renderer').TempoMark[] = [{ beat: 0, bpm: 60 }];
const MULTI: import('../score/renderer').TempoMark[] = [
  { beat: 0, bpm: 120 },
  { beat: 16, bpm: 60 },
];

describe('beatToSeconds', () => {
  it('120 bpm: 2 beats → 1 second', () => {
    expect(beatToSeconds(2, BPM120)).toBeCloseTo(1.0, 6);
  });

  it('60 bpm: 1 beat → 1 second', () => {
    expect(beatToSeconds(1, BPM60)).toBeCloseTo(1.0, 6);
  });

  it('0 beats → 0 seconds', () => {
    expect(beatToSeconds(0, BPM120)).toBe(0);
  });

  it('empty tempoMarks defaults to 120 bpm', () => {
    expect(beatToSeconds(2, [])).toBeCloseTo(1.0, 6);
  });

  it('tempo multiplier 0.5 doubles duration', () => {
    // 120 bpm at 0.5× → effectively 60 bpm → 2 beats = 2 s
    expect(beatToSeconds(2, BPM120, 0.5)).toBeCloseTo(2.0, 6);
  });

  it('tempo multiplier 2 halves duration', () => {
    // 120 bpm at 2× → effectively 240 bpm → 2 beats = 0.5 s
    expect(beatToSeconds(2, BPM120, 2)).toBeCloseTo(0.5, 6);
  });

  it('multi-tempo: before tempo change', () => {
    // 0→16 at 120 bpm; beat 8 = 4 s
    expect(beatToSeconds(8, MULTI)).toBeCloseTo(4.0, 6);
  });

  it('multi-tempo: after tempo change', () => {
    // 0→16 at 120 bpm = 8 s; 16→20 at 60 bpm = 4 s; total = 12 s
    expect(beatToSeconds(20, MULTI)).toBeCloseTo(12.0, 6);
  });

  it('multi-tempo: exactly at boundary', () => {
    // beat 16 is exactly the boundary; 16 * (60/120) = 8 s
    expect(beatToSeconds(16, MULTI)).toBeCloseTo(8.0, 6);
  });
});

describe('beatToSeconds / elapsedToBeat round-trip', () => {
  const cases: Array<{ label: string; beat: number; marks: import('../score/renderer').TempoMark[]; mult: number }> = [
    { label: '120 bpm, beat 4', beat: 4, marks: BPM120, mult: 1 },
    { label: '60 bpm, beat 3', beat: 3, marks: BPM60, mult: 1 },
    { label: '120 bpm, 0.75×, beat 6', beat: 6, marks: BPM120, mult: 0.75 },
    { label: 'multi-tempo, beat 20', beat: 20, marks: MULTI, mult: 1 },
    { label: 'multi-tempo, 0.5×, beat 18', beat: 18, marks: MULTI, mult: 0.5 },
  ];

  for (const { label, beat, marks, mult } of cases) {
    it(`round-trip: ${label}`, () => {
      const scaledMarks = marks.map((m) => ({ ...m, bpm: m.bpm * mult }));
      const secs = beatToSeconds(beat, marks, mult);
      const recovered = elapsedToBeat(secs * 1000, 0, scaledMarks);
      expect(recovered).toBeCloseTo(beat, 4);
    });
  }
});

describe('PlaybackEngine part selection', () => {
  it('selectPart filters notes used by the scheduler', () => {
    const starts: number[] = [];

    class FakeBufferSource {
      buffer: AudioBuffer | null = null;
      detune = { value: 0 };
      connect(): void {}
      start(): void { starts.push(1); }
      stop(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      createBufferSource(): AudioBufferSourceNode {
        return new FakeBufferSource() as unknown as AudioBufferSourceNode;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }

    class FakeSoundfont {
      getBuffer(): AudioBuffer {
        return {} as AudioBuffer;
      }
      getNearestSampledMidi(midi: number): number {
        return midi;
      }
    }

    const engine = new PlaybackEngine(
      new FakeAudioContext() as unknown as AudioContext,
      new FakeSoundfont() as unknown as import('./soundfont').SoundfontLoader,
    );

    const notes: import('../score/renderer').NoteModel[] = [
      { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null },
      { midi: 62, beat_start: 1, duration: 1, measure: 1, part: 'Piano', lyric: null },
      { midi: 64, beat_start: 2, duration: 1, measure: 1, part: 'PART I', lyric: null },
    ];

    engine.schedule(notes, BPM120, 'PART I', 1);
    engine.play(0);
    expect(starts).toHaveLength(2);

    starts.length = 0;
    engine.stop();
    engine.selectPart('Piano');
    engine.play(0);
    expect(starts).toHaveLength(1);
  });


  it('ignores non-existent part names and keeps current selection', () => {
    const starts: number[] = [];

    class FakeBufferSource {
      buffer: AudioBuffer | null = null;
      detune = { value: 0 };
      connect(): void {}
      start(): void { starts.push(1); }
      stop(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      createBufferSource(): AudioBufferSourceNode {
        return new FakeBufferSource() as unknown as AudioBufferSourceNode;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }

    class FakeSoundfont {
      getBuffer(): AudioBuffer {
        return {} as AudioBuffer;
      }
      getNearestSampledMidi(midi: number): number {
        return midi;
      }
    }

    const engine = new PlaybackEngine(
      new FakeAudioContext() as unknown as AudioContext,
      new FakeSoundfont() as unknown as import('./soundfont').SoundfontLoader,
    );

    const notes: import('../score/renderer').NoteModel[] = [
      { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null },
      { midi: 62, beat_start: 1, duration: 1, measure: 1, part: 'PART II', lyric: null },
    ];

    engine.schedule(notes, BPM120, 'PART I', 1);
    engine.selectPart('DOES NOT EXIST');
    engine.play(0);

    expect(starts).toHaveLength(1);
  });

  it('maintains beat continuity across mid-session part switch offset', () => {
    class FakeBufferSource {
      buffer: AudioBuffer | null = null;
      detune = { value: 0 };
      connect(): void {}
      start(): void {}
      stop(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      createBufferSource(): AudioBufferSourceNode {
        return new FakeBufferSource() as unknown as AudioBufferSourceNode;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }

    class FakeSoundfont {
      getBuffer(): AudioBuffer {
        return {} as AudioBuffer;
      }
      getNearestSampledMidi(midi: number): number {
        return midi;
      }
    }

    const ctx = new FakeAudioContext();
    const engine = new PlaybackEngine(
      ctx as unknown as AudioContext,
      new FakeSoundfont() as unknown as import('./soundfont').SoundfontLoader,
    );

    const notes: import('../score/renderer').NoteModel[] = [
      { midi: 60, beat_start: 0, duration: 16, measure: 1, part: 'PART I', lyric: null },
      { midi: 62, beat_start: 0, duration: 16, measure: 1, part: 'PART II', lyric: null },
    ];

    engine.schedule(notes, BPM120, 'PART I', 1);
    engine.play(0);

    ctx.currentTime = 2;
    const beforeSwitchBeat = engine.currentBeat;
    expect(beforeSwitchBeat).toBeCloseTo(3.8, 2);

    engine.selectPart('PART II');

    ctx.currentTime = 2.03;
    expect(engine.currentBeat).toBeGreaterThan(beforeSwitchBeat);
    expect(engine.currentBeat).toBeCloseTo(3.87, 2);
  });

  it('uses oscillator fallback when soundfont samples are unavailable', () => {
    const starts: number[] = [];

    class FakeOscillator {
      type: OscillatorType = 'sine';
      frequency = { value: 0 };
      connect(): void {}
      start(): void { starts.push(1); }
      stop(): void {}
    }

    class FakeGain {
      gain = {
        setValueAtTime(): void {},
        linearRampToValueAtTime(): void {},
      };
      connect(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      createBufferSource(): AudioBufferSourceNode {
        throw new Error('Buffer source should not be used in fallback mode');
      }
      createOscillator(): OscillatorNode {
        return new FakeOscillator() as unknown as OscillatorNode;
      }
      createGain(): GainNode {
        return new FakeGain() as unknown as GainNode;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }

    class MissingSoundfont {
      getBuffer(): AudioBuffer | null {
        return null;
      }
      getNearestSampledMidi(): number | null {
        return null;
      }
    }

    const engine = new PlaybackEngine(
      new FakeAudioContext() as unknown as AudioContext,
      new MissingSoundfont() as unknown as import('./soundfont').SoundfontLoader,
    );

    engine.schedule(
      [{ midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null }],
      BPM120,
      'PART I',
      1,
    );
    engine.play(0);
    expect(starts).toHaveLength(1);
  });

});
