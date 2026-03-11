/**
 * ScoreCursor — drives the OSMD visual cursor from a beat clock.
 *
 * In Day 8, the beat clock is a wall-clock approximation (performance.now()).
 * In Day 9+, replace the internal _tick() call with seekToBeat() driven by
 * AudioContext.currentTime converted to beats — the interface is already
 * designed for that handover.
 *
 * Design notes:
 *   - Cursor advance is O(1) amortised during forward playback: we never
 *     reset unless seeking backward, so we only call cursor.next() for the
 *     delta on each RAF frame.
 *   - Tempo changes are respected: elapsedToBeat() in timing.ts integrates
 *     across all TempoMark entries from startBeat onwards.
 *   - scrollIntoView with inline:'center' keeps the cursor horizontally
 *     centred in the scroll container without JS scroll calculation.
 *   - RealValue * 4: OSMD's currentTimeStamp.RealValue is in whole notes.
 *     Multiplying by 4 converts to quarter-note beats (our ScoreModel unit).
 *     This is a unit conversion, not a 4/4 time-signature assumption.
 */
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ScoreModel } from './renderer';
import { elapsedToBeat } from './timing';

export class ScoreCursor {
  private readonly osmd: OpenSheetMusicDisplay;
  private readonly model: ScoreModel;

  private rafId: number | null = null;
  private _playing = false;
  private startWallMs = 0;
  private startBeat = 0;
  /**
   * Last beat position the OSMD cursor was advanced to.
   * Lets us skip the O(n) reset+replay on each RAF tick.
   */
  private _lastAdvancedBeat = 0;

  constructor(osmd: OpenSheetMusicDisplay, model: ScoreModel) {
    this.osmd = osmd;
    this.model = model;
  }

  /** Begin advancing the cursor from `fromBeat` using the internal wall clock. */
  play(fromBeat = 0): void {
    if (this._playing) return;
    this.startBeat = fromBeat;
    this.startWallMs = performance.now();
    this._playing = true;

    if (fromBeat === 0 || fromBeat < this._lastAdvancedBeat) {
      this.osmd.cursor.reset();
      this._lastAdvancedBeat = 0;
    }
    this.osmd.cursor.show();
    this._tick();
  }

  pause(): void {
    this._playing = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  stop(): void {
    this.pause();
    this._lastAdvancedBeat = 0;
    this.startBeat = 0;
    this.osmd.cursor.reset();
    this.osmd.cursor.hide();
  }

  /**
   * Seek the cursor to a specific beat position.
   * Call this from Day 9+ pitch overlay to drive the cursor from
   * AudioContext.currentTime rather than the internal wall clock.
   */
  seekToBeat(beat: number): void {
    if (beat < this._lastAdvancedBeat) {
      this.osmd.cursor.reset();
      this._lastAdvancedBeat = 0;
    }
    this._advanceTo(beat);
  }

  get playing(): boolean {
    return this._playing;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _tick(): void {
    if (!this._playing) return;
    const elapsedMs = performance.now() - this.startWallMs;
    const beat = this.startBeat + elapsedToBeat(elapsedMs, this.startBeat, this.model.tempo_marks);
    this._advanceTo(beat);

    if (!this.osmd.cursor.Iterator.EndReached) {
      this.rafId = requestAnimationFrame(() => this._tick());
    } else {
      this._playing = false;
    }
  }

  /**
   * Advance OSMD cursor forward to targetBeat without resetting.
   * Only calls cursor.next() for the increment since the last frame — O(1)
   * amortised over the whole piece.
   *
   * RealValue * 4: whole notes → quarter-note beats (unit conversion, not
   * a 4/4 assumption — see file-level note).
   */
  private _advanceTo(targetBeat: number): void {
    while (!this.osmd.cursor.Iterator.EndReached) {
      const cursorBeat = this.osmd.cursor.Iterator.currentTimeStamp.RealValue * 4;
      if (cursorBeat >= targetBeat) break;
      this.osmd.cursor.next();
      this._lastAdvancedBeat = cursorBeat;
    }
    this._scrollToCursor();
  }

  private _scrollToCursor(): void {
    const el = this.osmd.cursor.cursorElement;
    if (el) {
      // 'auto' is instant; avoids fighting with the 60Hz tick when smooth.
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }
}
