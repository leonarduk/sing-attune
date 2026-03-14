interface TimelineAnchor {
  frameMs: number;
  audioTimeSec: number;
}

/**
 * Maps backend frame timestamps (ms since playback start) to the frontend
 * audio clock and vice versa. Anchors are rebased on start/resume/seek.
 */
export class PitchTimelineSync {
  private anchor: TimelineAnchor | null = null;
  private syncOffsetMs = 0;

  reset(): void {
    this.anchor = null;
  }

  setSyncOffsetMs(offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) return;
    if (this.anchor) {
      this.anchor.frameMs += (offsetMs - this.syncOffsetMs);
    }
    this.syncOffsetMs = offsetMs;
  }

  reanchor(frameMs: number, audioTimeSec: number): void {
    this.anchor = {
      frameMs: frameMs + this.syncOffsetMs,
      audioTimeSec,
    };
  }

  hasAnchor(): boolean {
    return this.anchor !== null;
  }

  frameToAudioTime(frameMs: number): number | null {
    if (!this.anchor) return null;
    return this.anchor.audioTimeSec + (((frameMs + this.syncOffsetMs) - this.anchor.frameMs) / 1000);
  }

  audioToFrameTime(audioTimeSec: number): number | null {
    if (!this.anchor) return null;
    return (this.anchor.frameMs + ((audioTimeSec - this.anchor.audioTimeSec) * 1000)) - this.syncOffsetMs;
  }

  isFrameStale(frameMs: number, nowAudioTimeSec: number, visibleWindowMs: number): boolean {
    const nowFrameMs = this.audioToFrameTime(nowAudioTimeSec);
    // No anchor yet: drop the frame rather than render it in the wrong position.
    if (nowFrameMs === null) return true;
    return frameMs < (nowFrameMs - visibleWindowMs);
  }
}
