import { describe, expect, it } from 'vitest';
import {
  MAX_CONFIDENCE_THRESHOLD,
  MAX_TRAIL_MS,
  MIN_CONFIDENCE_THRESHOLD,
  MIN_TRAIL_MS,
  normalizeOverlaySettings,
} from './overlay';

describe('normalizeOverlaySettings', () => {
  it('clamps confidence and trail values to supported ranges', () => {
    expect(normalizeOverlaySettings({
      confidenceThreshold: 0.1,
      trailMs: 50,
    })).toEqual({
      confidenceThreshold: MIN_CONFIDENCE_THRESHOLD,
      trailMs: MIN_TRAIL_MS,
    });

    expect(normalizeOverlaySettings({
      confidenceThreshold: 1.5,
      trailMs: 15000,
    })).toEqual({
      confidenceThreshold: MAX_CONFIDENCE_THRESHOLD,
      trailMs: MAX_TRAIL_MS,
    });
  });

  it('uses fallback defaults for non-finite values', () => {
    expect(normalizeOverlaySettings({
      confidenceThreshold: Number.NaN,
      trailMs: Number.POSITIVE_INFINITY,
    })).toEqual({
      confidenceThreshold: MIN_CONFIDENCE_THRESHOLD,
      trailMs: 2000,
    });
  });
});
