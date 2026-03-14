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

  reset(): void {
    this.anchor = null;
  }

  reanchor(frameMs: number, audioTimeSec: number): void {
    this.anchor = {
      frameMs,
      audioTimeSec,
    };
  }

  hasAnchor(): boolean {
    return this.anchor !== null;
  }

  frameToAudioTime(frameMs: number): number | null {
    if (!this.anchor) return null;
    return this.anchor.audioTimeSec + ((frameMs - this.anchor.frameMs) / 1000);
  }

  audioToFrameTime(audioTimeSec: number): number | null {
    if (!this.anchor) return null;
    return this.anchor.frameMs + ((audioTimeSec - this.anchor.audioTimeSec) * 1000);
  }

  isFrameStale(frameMs: number, nowAudioTimeSec: number, visibleWindowMs: number): boolean {
    const nowFrameMs = this.audioToFrameTime(nowAudioTimeSec);
    if (nowFrameMs === null) return false;
    return frameMs < (nowFrameMs - visibleWindowMs);
  }
}
