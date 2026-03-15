/**
 * Unit tests for PlaybackEngine timing math.
 *
 * beatToSeconds() is the inverse of elapsedToBeat() from timing.ts.
 * These tests verify correctness across single-tempo, multi-tempo, and
 * tempo-multiplier cases without requiring an AudioContext mock.
 */
import { describe, it, expect } from 'vitest';
import { beatToSeconds, PlaybackEngine, scheduleNotes } from './engine';
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



describe('scheduleNotes', () => {
  const notes: import('../score/renderer').NoteModel[] = [
    { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null },
    { midi: 62, beat_start: 2, duration: 2, measure: 1, part: 'PART I', lyric: null },
  ];

  it('scales event start times at 75% tempo', () => {
    const events = scheduleNotes(notes, BPM120, 0, 10, 0.75);
    expect(events).toHaveLength(2);
    expect(events[0].startAt).toBeCloseTo(10, 6);
    expect(events[1].startAt).toBeCloseTo(11.333333, 5);
  });

  it('scales event start times at 50% tempo', () => {
    const events = scheduleNotes(notes, BPM120, 0, 10, 0.5);
    expect(events).toHaveLength(2);
    expect(events[0].startAt).toBeCloseTo(10, 6);
    expect(events[1].startAt).toBeCloseTo(12, 6);
  });

  it('applies positive latency offset to event start times', () => {
    const events = scheduleNotes(notes, BPM120, 0, 10, 1, 0.2);
    expect(events[0].startAt).toBeCloseTo(10.2, 6);
    expect(events[1].startAt).toBeCloseTo(11.2, 6);
  });

  it('applies negative latency offset to event start times', () => {
    const events = scheduleNotes(notes, BPM120, 0, 10, 1, -0.1);
    expect(events[0].startAt).toBeCloseTo(9.9, 6);
    expect(events[1].startAt).toBeCloseTo(10.9, 6);
  });
});

describe('PlaybackEngine part gain lifecycle', () => {
  it('disconnects stale part GainNodes when scheduling a new note set', () => {
    const disconnected: string[] = [];

    class FakeBufferSource {
      buffer: AudioBuffer | null = null;
      detune = { value: 0 };
      connect(): void {}
      start(): void {}
      stop(): void {}
    }

    class FakeGain {
      constructor(private readonly id: string) {}
      gain = { value: 1 };
      connect(): void {}
      disconnect(): void {
        disconnected.push(this.id);
      }
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      private gainCount = 0;
      createBufferSource(): AudioBufferSourceNode {
        return new FakeBufferSource() as unknown as AudioBufferSourceNode;
      }
      createGain(): GainNode {
        this.gainCount += 1;
        return new FakeGain(`gain-${this.gainCount}`) as unknown as GainNode;
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

    engine.schedule(
      [
        { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null },
        { midi: 62, beat_start: 1, duration: 1, measure: 1, part: 'PART II', lyric: null },
      ],
      BPM120,
      'PART I',
      1,
    );

    expect(disconnected).toEqual([]);

    engine.schedule(
      [{ midi: 64, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null }],
      BPM120,
      'PART I',
      1,
    );

    expect(disconnected).toEqual(['gain-1', 'gain-2']);
  });

  it('creates part GainNodes on demand via setPartGain after schedule', () => {
    const created: string[] = [];

    class FakeGain {
      constructor(private readonly id: string) {}
      gain = { value: 1 };
      connect(): void {}
      disconnect(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      private gainCount = 0;
      createBufferSource(): AudioBufferSourceNode {
        return {} as AudioBufferSourceNode;
      }
      createGain(): GainNode {
        this.gainCount += 1;
        const id = `gain-${this.gainCount}`;
        created.push(id);
        return new FakeGain(id) as unknown as GainNode;
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

    engine.schedule(
      [{ midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null }],
      BPM120,
      'PART I',
      1,
    );

    expect(created).toEqual(['gain-1']);

    engine.setPartGain('PART III', 0.35);
    expect(created).toEqual(['gain-1', 'gain-2']);
  });
});


describe('PlaybackEngine latency compensation', () => {
  it('loads preflight latency fresh on each play call', () => {
    const starts: number[] = [];

    class FakeBufferSource {
      buffer: AudioBuffer | null = null;
      detune = { value: 0 };
      connect(): void {}
      start(when?: number): void { starts.push(when ?? 0); }
      stop(): void {}
    }

    class FakeAudioContext {
      currentTime = 100;
      state: AudioContextState = 'running';
      destination = {} as AudioDestinationNode;
      createBufferSource(): AudioBufferSourceNode {
        return new FakeBufferSource() as unknown as AudioBufferSourceNode;
      }
      createGain(): GainNode {
        return { gain: { value: 1 }, connect(): void {} } as unknown as GainNode;
      }
      createOscillator(): OscillatorNode {
        return {} as OscillatorNode;
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

    window.localStorage.setItem('sing-attune.preflight.latencyMs', '200');
    const ctx = new FakeAudioContext();
    const engine = new PlaybackEngine(
      ctx as unknown as AudioContext,
      new FakeSoundfont() as unknown as import('./soundfont').SoundfontLoader,
    );
    const notes: import('../score/renderer').NoteModel[] = [
      { midi: 60, beat_start: 0, duration: 1, measure: 1, part: 'PART I', lyric: null },
    ];

    engine.schedule(notes, BPM120, 'PART I', 1);
    engine.play(0);
    expect(starts[0]).toBeCloseTo(100.3, 6);

    engine.stop();
    ctx.currentTime = 200;
    window.localStorage.setItem('sing-attune.preflight.latencyMs', '-100');
    engine.play(0);
    expect(starts[1]).toBeCloseTo(200.005, 6);

    window.localStorage.removeItem('sing-attune.preflight.latencyMs');
  });
});

describe('PlaybackEngine part selection', () => {
  it('schedules all notes regardless of selected part', () => {
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
      createGain(): GainNode {
        return { gain: { value: 1 }, connect(): void {} } as unknown as GainNode;
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
    expect(starts).toHaveLength(3);

    starts.length = 0;
    engine.stop();
    engine.selectPart('Piano');
    engine.play(0);
    expect(starts).toHaveLength(3);
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
      createGain(): GainNode {
        return { gain: { value: 1 }, connect(): void {} } as unknown as GainNode;
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

    expect(starts).toHaveLength(2);
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
      createGain(): GainNode {
        return { gain: { value: 1 }, connect(): void {} } as unknown as GainNode;
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


  it('caps fallback envelope release to note end', () => {
    const gainEvents: Array<{ kind: 'set' | 'ramp'; value: number; time: number }> = [];
    let stopTime = 0;

    class FakeOscillator {
      type: OscillatorType = 'sine';
      frequency = { value: 0 };
      connect(): void {}
      start(): void {}
      stop(when?: number): void {
        stopTime = when ?? 0;
      }
    }

    class FakeGain {
      gain = {
        setValueAtTime(value: number, time: number): void {
          gainEvents.push({ kind: 'set', value, time });
        },
        linearRampToValueAtTime(value: number, time: number): void {
          gainEvents.push({ kind: 'ramp', value, time });
        },
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

    const releaseHolds = gainEvents.filter((e) => e.kind === 'set' && e.value === 0.12);
    const releaseRamp = gainEvents.find((e) => e.kind === 'ramp' && e.value === 0.0001);
    const finalReleaseHold = releaseHolds[releaseHolds.length - 1];

    expect(finalReleaseHold).toBeDefined();
    expect(releaseRamp).toBeDefined();
    expect(finalReleaseHold?.time).toBeLessThanOrEqual(stopTime);
    expect(releaseRamp?.time).toBeCloseTo(stopTime, 6);
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
