import { describe, expect, it } from 'vitest';
import {
  beatFromClick,
  extractMeasureHitZones,
  measureBoundaryFromPoint,
  type MeasureHitZone,
} from './click-seek';

describe('beatFromClick', () => {
  const zones: MeasureHitZone[] = [
    { x: 0, y: 0, width: 100, height: 40, beatStart: 0, beatDuration: 4 },
    { x: 120, y: 0, width: 100, height: 40, beatStart: 4, beatDuration: 4 },
  ];

  it('maps click position proportionally within the matching measure', () => {
    const beat = beatFromClick(zones, 50, 20);
    expect(beat).toBeCloseTo(2, 5);
  });

  it('chooses nearest measure when click is outside any hit zone', () => {
    const beat = beatFromClick(zones, 240, 20);
    // Clamped to measure end when clicking beyond right edge.
    expect(beat).toBeCloseTo(8, 5);
  });

  it('returns null for empty zone list', () => {
    expect(beatFromClick([], 10, 10)).toBeNull();
  });
});

describe('measureBoundaryFromPoint', () => {
  const zones: MeasureHitZone[] = [
    { x: 0, y: 0, width: 100, height: 40, beatStart: 8, beatDuration: 4 },
  ];

  it('returns start and end beats for the selected measure', () => {
    expect(measureBoundaryFromPoint(zones, 40, 20)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      startBeat: 8,
      endBeat: 12,
    });
  });
});

describe('extractMeasureHitZones', () => {
  it('extracts beat ranges and geometry from OSMD-like measure structures', () => {
    const osmdLike = {
      GraphicSheet: {
        MeasureList: [
          [
            {
              boundingBox: {
                absolutePosition: { x: 10, y: 20 },
                size: {
                  width: { realValue: 80 },
                  height: { realValue: 50 },
                },
              },
              parentSourceMeasure: {
                AbsoluteTimestamp: { RealValue: 1.5 },
                Duration: { RealValue: 1 },
              },
            },
          ],
        ],
      },
    };

    const zones = extractMeasureHitZones(osmdLike);
    expect(zones).toEqual([
      { x: 10, y: 20, width: 80, height: 50, beatStart: 6, beatDuration: 4 },
    ]);
  });

  it('returns empty list when shape is missing', () => {
    expect(extractMeasureHitZones({})).toEqual([]);
  });
});
