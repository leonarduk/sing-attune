/**
 * PlaybackEngine — schedules all part notes as Web Audio API events.
 *
 * Design principles:
 *
 * 1. Pre-schedule everything at play() time.
 *    All notes are queued as AudioBufferSourceNode.start(absoluteTime) calls
 *    before the first note plays. The audio thread fires them precisely. This
 *    avoids the jitter of a JavaScript setTimeout/setInterval scheduler.
 *
 * 2. AudioContext.currentTime is the master clock.
 *    It is monotonically increasing and hardware-driven. Never use Date.now()
 *    or performance.now() for audio timing. The cursor and backend sync must
 *    derive position from ctx.currentTime.
 *
 * 3. Tempo changes reschedule remaining notes.
 *    setTempoMultiplier() records currentBeat, cancels future sources, and
 *    reschedules from that beat with the new multiplier. There is a short
 *    RESCHEDULE_OFFSET_S gap (30 ms) to ensure no audible discontinuity.
 *
 * 4. Pitch correction via detune.
 *    The gleitz soundfont only includes a subset of MIDI notes. For notes not
 *    directly sampled, we use the nearest available buffer and set
 *    AudioBufferSourceNode.detune to the cent offset (100 cents per semitone).
 *
 * Day 9 handover:
 *    engine.currentBeat and engine.startAudioTime are already exposed.
 *    main.ts drives ScoreCursor.seekToBeat(engine.currentBeat) from a RAF loop.
 *    No changes to this class are required for the pitch overlay.
 */
import { elapsedToBeat } from '../score/timing';
import type { NoteModel, TempoMark } from '../score/renderer';
import type { SoundfontLoader } from './soundfont';

/** Seconds per beat at the given BPM */
function spb(bpm: number): number { return 60 / bpm; }

/**
 * Convert a beat position to wall-clock seconds relative to beat 0,
 * integrating across all tempo mark boundaries.
 *
 * tempoMultiplier scales all BPMs uniformly — e.g. 0.5 halves the speed.
 * This is the inverse of elapsedToBeat() in timing.ts.
 */
export function beatToSeconds(
  beat: number,
  tempoMarks: TempoMark[],
  tempoMultiplier = 1,
): number {
  if (tempoMarks.length === 0) return beat * spb(120) / tempoMultiplier;
  let secs = 0;
  let prevBeat = tempoMarks[0].beat;
  let prevBpm = tempoMarks[0].bpm;
  for (let i = 1; i < tempoMarks.length; i++) {
    const mark = tempoMarks[i];
    if (mark.beat >= beat) break;
    secs += (mark.beat - prevBeat) * spb(prevBpm) / tempoMultiplier;
    prevBeat = mark.beat;
    prevBpm = mark.bpm;
  }
  secs += (beat - prevBeat) * spb(prevBpm) / tempoMultiplier;
  return secs;
}

export type PlaybackState = 'idle' | 'playing' | 'paused';

// Constants
/** Seconds between play() call and first note — gives audio thread time to buffer. */
const SCHEDULE_OFFSET_S = 0.1;
/** Gap between tempo change and rescheduled notes — avoids audible overlap. */
const RESCHEDULE_OFFSET_S = 0.03;
/** Small stop/start guard to avoid edge scheduling races at currentTime. */
const STOP_SAFETY_OFFSET_S = 0.005;
/** Extra release time appended to each note's stop time for natural decay. */
const RELEASE_TAIL_S = 0.5;
/** Ignore notes whose scheduled start time is already in the past by this margin. */
const LATE_TOLERANCE_S = 0.01;

export class PlaybackEngine {
  /** The AudioContext. Expose so main.ts can read currentTime for cursor sync. */
  readonly ctx: AudioContext;
  private readonly sf: SoundfontLoader;

  private _state: PlaybackState = 'idle';
  private _sources: AudioBufferSourceNode[] = [];

  /**
   * AudioContext.currentTime value that corresponds to _startBeat.
   * beat_position = _startBeat + elapsedToBeat((ctx.currentTime - _startAudioTime) * 1000, …)
   */
  private _startAudioTime = 0;
  /** Beat number from which the current scheduling segment started. */
  private _startBeat = 0;

  // Cached schedule parameters
  private _allNotes: NoteModel[] = [];
  private _selectedPart = '';
  private _notes: NoteModel[] = [];
  private _tempoMarks: TempoMark[] = [];
  private _tempoMultiplier = 1;
  private _transposeSemitones = 0;

  constructor(ctx: AudioContext, sf: SoundfontLoader) {
    this.ctx = ctx;
    this.sf = sf;
  }

  // ── Public state ─────────────────────────────────────────────────────────────

  get state(): PlaybackState { return this._state; }
  get playing(): boolean { return this._state === 'playing'; }
  get tempoMultiplier(): number { return this._tempoMultiplier; }

  /**
   * AudioContext.currentTime aligned to _startBeat.
   * Expose for cursor sync: compute beat in main.ts as engine.currentBeat.
   */
  get startAudioTime(): number { return this._startAudioTime; }
  get startBeat(): number { return this._startBeat; }

  /**
   * Current beat position derived from AudioContext.currentTime.
   * Returns _startBeat when not playing (paused or idle).
   * Returns _startBeat before SCHEDULE_OFFSET_S has elapsed after play().
   */
  get currentBeat(): number {
    if (this._state !== 'playing') return this._startBeat;
    return this._beatAtTime(this.ctx.currentTime);
  }

  // ── Public commands ───────────────────────────────────────────────────────────

  /**
   * Set the notes and parameters for the next play() call.
   * Call this whenever the selected part or tempo changes.
   * Safe to call while playing — changes take effect on next play() or
   * next setTempoMultiplier() call.
   */
  schedule(
    notes: NoteModel[],
    tempoMarks: TempoMark[],
    partName: string,
    tempoMultiplier = 1,
  ): void {
    this._allNotes = notes;
    this._selectedPart = partName;
    this._notes = this._allNotes.filter((n) => n.part === this._selectedPart);
    this._tempoMarks = tempoMarks;
    this._tempoMultiplier = tempoMultiplier;
  }

  /**
   * Change the selected part without reloading the page.
   *
   * If currently playing, pending sources are cancelled and the queue is
   * rebuilt from the current AudioContext.currentTime-aligned beat position.
   */
  selectPart(partName: string): void {
    const partExists = this._allNotes.some((n) => n.part === partName);
    if (!partExists) return;

    this._selectedPart = partName;
    this._notes = this._allNotes.filter((n) => n.part === this._selectedPart);

    if (this._state !== 'playing') return;

    const switchAt = this.ctx.currentTime + STOP_SAFETY_OFFSET_S + RESCHEDULE_OFFSET_S;
    const beat = this._beatAtTime(switchAt);
    this._stopSources(switchAt);
    this._startBeat = beat;
    this._startAudioTime = switchAt;
    this._scheduleFrom(beat, switchAt);
  }

  /**
   * Begin playback from fromBeat.
   * AudioContext is resumed if it was suspended (autoplay policy).
   * SCHEDULE_OFFSET_S elapses before the first note sounds, giving the audio
   * thread time to buffer without scheduling overruns.
   */
  play(fromBeat = 0): void {
    if (this._state === 'playing') return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this._startBeat = fromBeat;
    this._startAudioTime = this.ctx.currentTime + SCHEDULE_OFFSET_S;
    this._scheduleFrom(fromBeat, this._startAudioTime);
    this._state = 'playing';
  }

  /** Suspend playback, preserving current beat position for resume. */
  pause(): void {
    if (this._state !== 'playing') return;
    const beat = this.currentBeat;
    this._stopSources(this.ctx.currentTime + STOP_SAFETY_OFFSET_S);
    this._startBeat = beat;
    this._state = 'paused';
  }

  /** Stop playback and reset to beat 0. */
  stop(): void {
    this._stopSources();
    this._startBeat = 0;
    this._state = 'idle';
  }

  /**
   * Adjust playback speed and reschedule remaining notes.
   *
   * If playing: records currentBeat, cancels all future sources, reschedules
   * from that beat with the new multiplier. A RESCHEDULE_OFFSET_S gap ensures
   * no audible overlap between the old and new schedules.
   *
   * If not playing: stores the multiplier for the next play() call.
   */

  /**
   * Seek to a beat position.
   *
   * If playing, cancels all future scheduled sources and immediately reschedules
   * from `beat` with a short `RESCHEDULE_OFFSET_S` gap to avoid audible overlap.
   * If paused or idle, stores the beat for the next `play()` call.
   *
   * @param beat - Target beat number. Values below 0 are clamped to 0.
   */
  seekToBeat(beat: number): void {
    const targetBeat = Math.max(0, beat);
    if (this._state === 'playing') {
      this._stopSources();
      this._startBeat = targetBeat;
      this._startAudioTime = this.ctx.currentTime + RESCHEDULE_OFFSET_S;
      this._scheduleFrom(targetBeat, this._startAudioTime);
      return;
    }
    this._startBeat = targetBeat;
  }


  /**
   * Set playback transposition in semitones.
   * If playing, reschedule remaining notes immediately at the new pitch.
   */
  setTransposeSemitones(semitones: number): void {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (this._state !== 'playing') {
      this._transposeSemitones = clamped;
      return;
    }

    const beat = this.currentBeat;
    this._stopSources();
    this._transposeSemitones = clamped;
    this._startBeat = beat;
    this._startAudioTime = this.ctx.currentTime + RESCHEDULE_OFFSET_S;
    this._scheduleFrom(beat, this._startAudioTime);
  }

  setTempoMultiplier(multiplier: number): void {
    if (this._state !== 'playing') {
      this._tempoMultiplier = multiplier;
      return;
    }
    const beat = this.currentBeat;
    this._stopSources();
    this._tempoMultiplier = multiplier;
    this._startBeat = beat;
    this._startAudioTime = this.ctx.currentTime + RESCHEDULE_OFFSET_S;
    this._scheduleFrom(beat, this._startAudioTime);
    // _state remains 'playing'
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * TempoMarks with BPM scaled by the current multiplier.
   * Used by elapsedToBeat() to derive currentBeat from ctx.currentTime.
   */
  private get _scaledTempoMarks(): TempoMark[] {
    return this._tempoMarks.map((m) => ({ ...m, bpm: m.bpm * this._tempoMultiplier }));
  }

  private _beatAtTime(audioTime: number): number {
    const elapsedS = audioTime - this._startAudioTime;
    if (elapsedS < 0) return this._startBeat;
    return this._startBeat + elapsedToBeat(elapsedS * 1000, this._startBeat, this._scaledTempoMarks);
  }

  /**
   * Schedule all notes that start at or after fromBeat.
   * Each note becomes one AudioBufferSourceNode event anchored to originTime.
   *
   * originTime is the AudioContext.currentTime that corresponds to fromBeat.
   * Notes before fromBeat are skipped; notes too far in the past (> LATE_TOLERANCE_S
   * behind ctx.currentTime) are also skipped to avoid scheduling overruns.
   */
  private _scheduleFrom(fromBeat: number, originTime: number): void {
    const originOffsetS = beatToSeconds(fromBeat, this._tempoMarks, this._tempoMultiplier);

    for (const note of this._notes) {
      // Skip notes that ended before the resume point
      if (note.beat_start + note.duration <= fromBeat) continue;

      const noteStartOffsetS =
        beatToSeconds(note.beat_start, this._tempoMarks, this._tempoMultiplier) - originOffsetS;
      const startAt = originTime + noteStartOffsetS;

      // Skip notes that are already too late to schedule
      if (startAt < this.ctx.currentTime - LATE_TOLERANCE_S) continue;

      const targetMidi = note.midi + this._transposeSemitones;
      const buf = this.sf.getBuffer(targetMidi);
      if (!buf) continue;

      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      // Pitch-correct: detune by the cent difference between desired MIDI note
      // and the sampled MIDI note (100 cents per semitone).
      const sampledMidi = this.sf.getNearestSampledMidi(targetMidi);
      if (sampledMidi !== null) {
        src.detune.value = (targetMidi - sampledMidi) * 100;
      }

      src.connect(this.ctx.destination);

      // Duration in seconds + release tail for natural piano decay
      const noteDurS =
        beatToSeconds(note.beat_start + note.duration, this._tempoMarks, this._tempoMultiplier) -
        beatToSeconds(note.beat_start, this._tempoMarks, this._tempoMultiplier) +
        RELEASE_TAIL_S;

      const safeStart = Math.max(startAt, this.ctx.currentTime + STOP_SAFETY_OFFSET_S);
      src.start(safeStart);
      src.stop(safeStart + noteDurS);

      this._sources.push(src);
    }
  }

  /** Stop all scheduled sources immediately. */
  private _stopSources(stopAt = this.ctx.currentTime): void {
    for (const src of this._sources) {
      try { src.stop(stopAt); } catch { /* already stopped or never started */ }
    }
    this._sources = [];
  }
}
