/**
 * ScoreCursor — drives the OSMD visual cursor from a beat clock.
 *
 * Day 8a used an internal wall-clock loop (performance.now()). Day 8b
 * replaced that with external seekToBeat() calls driven by
 * AudioContext.currentTime via PlaybackEngine.currentBeat in main.ts.
 * The internal _tick() / play() path is retained for isolated testing
 * but is not used in normal operation.
 *
 * Design notes:
 *   - osmd is public so main.ts can call osmd.cursor.show() after stop()
 *     (stop() hides the cursor; show() is needed before RAF starts).
 *   - Cursor advance is O(1) amortised during forward playback: we never
 *     reset unless seeking backward, so we only call cursor.next() for the
 *     delta on each RAF frame.
 *   - Tempo changes are respected: elapsedToBeat() in timing.ts integrates
 *     across all TempoMark entries from startBeat onwards.
 *   - scrollIntoView with block:'nearest' prevents vertical jumps when the
 *     score container is taller than the viewport; inline:'center' keeps the
 *     cursor horizontally centred within the scroll container.
 *   - RealValue * 4: OSMD's currentTimeStamp.RealValue is in whole notes.
 *     Multiplying by 4 converts to quarter-note beats (our ScoreModel unit).
 *     This is a unit conversion, not a 4/4 time-signature assumption.
 *   - JS is single-threaded, so there is no race between the EndReached check
 *     and requestAnimationFrame scheduling. pause() calls cancelAnimationFrame
 *     before any RAF callback can fire, and _tick() guards on _playing anyway.
 */
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ScoreModel } from './renderer';
import { elapsedToBeat } from './timing';

export class ScoreCursor {
  /** Public so main.ts can call osmd.cursor.show() after stop(). */
  readonly osmd: OpenSheetMusicDisplay;
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
   * Called from main.ts RAF loop (engine.currentBeat) in Day 8b+.
   *
   * OSMD's cursor is a forward-only iterator: reset() goes to beat 0;
   * next() advances one position. There is no O(1) seek. Seeking backward
   * therefore resets to 0 and replays cursor.next() forward to the target.
   * For typical choir piece lengths (~200 cursor positions) this is fast
   * enough to be imperceptible. If it ever becomes a bottleneck, consider
   * OSMD's CursorType.CurrentArea variant which supports independent scrolling.
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

  // ── Private ───────────────────────────────────────────────────────────────────

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
      // block:'nearest' prevents vertical jumps; inline:'center' keeps
      // the cursor horizontally centred within the #score-container div.
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }
}
