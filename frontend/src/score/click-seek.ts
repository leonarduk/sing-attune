export interface MeasureHitZone {
  x: number;
  y: number;
  width: number;
  height: number;
  beatStart: number;
  beatDuration: number;
}

export interface MeasureBoundary {
  x: number;
  y: number;
  width: number;
  height: number;
  startBeat: number;
  endBeat: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getBoxDimension(box: Record<string, unknown>, key: string): number | null {
  const direct = asFiniteNumber(box[key]);
  if (direct !== null) return direct;

  const nested = box[key];
  if (nested && typeof nested === 'object') {
    const maybeReal = asFiniteNumber((nested as Record<string, unknown>).realValue);
    if (maybeReal !== null) return maybeReal;
  }

  return null;
}

export function extractMeasureHitZones(osmd: unknown): MeasureHitZone[] {
  const graphicSheet = (osmd as { GraphicSheet?: unknown })?.GraphicSheet;
  if (!graphicSheet || typeof graphicSheet !== 'object') return [];

  const measureList = (graphicSheet as { MeasureList?: unknown }).MeasureList;
  if (!Array.isArray(measureList)) return [];

  const zones: MeasureHitZone[] = [];

  for (const staffMeasures of measureList) {
    if (!Array.isArray(staffMeasures)) continue;

    for (const graphicalMeasure of staffMeasures) {
      if (!graphicalMeasure || typeof graphicalMeasure !== 'object') continue;

      const box = (graphicalMeasure as { boundingBox?: unknown }).boundingBox;
      const sourceMeasure = (graphicalMeasure as { parentSourceMeasure?: unknown }).parentSourceMeasure;
      if (!box || typeof box !== 'object' || !sourceMeasure || typeof sourceMeasure !== 'object') continue;

      const absolute = (box as { absolutePosition?: unknown }).absolutePosition;
      const size = (box as { size?: unknown }).size;
      if (!absolute || typeof absolute !== 'object' || !size || typeof size !== 'object') continue;

      const x = asFiniteNumber((absolute as Record<string, unknown>).x);
      const y = asFiniteNumber((absolute as Record<string, unknown>).y);
      const width = getBoxDimension(size as Record<string, unknown>, 'width');
      const height = getBoxDimension(size as Record<string, unknown>, 'height');

      const timestamp = (sourceMeasure as { AbsoluteTimestamp?: unknown }).AbsoluteTimestamp;
      const duration = (sourceMeasure as { Duration?: unknown }).Duration;
      const timestampReal = timestamp && typeof timestamp === 'object'
        ? asFiniteNumber((timestamp as Record<string, unknown>).RealValue)
        : null;
      const durationReal = duration && typeof duration === 'object'
        ? asFiniteNumber((duration as Record<string, unknown>).RealValue)
        : null;

      if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
      if (timestampReal === null || durationReal === null || durationReal <= 0) continue;

      zones.push({
        x,
        y,
        width,
        height,
        beatStart: timestampReal * 4,
        beatDuration: durationReal * 4,
      });
    }
  }

  return zones;
}

export function measureBoundaryFromPoint(zones: MeasureHitZone[], clickX: number, clickY: number): MeasureBoundary | null {
  if (zones.length === 0) return null;

  const containing = zones.filter((zone) => (
    clickX >= zone.x
    && clickX <= zone.x + zone.width
    && clickY >= zone.y
    && clickY <= zone.y + zone.height
  ));

  const pool = containing.length > 0 ? containing : zones;

  let bestZone = pool[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const zone of pool) {
    const cx = zone.x + zone.width / 2;
    const cy = zone.y + zone.height / 2;
    const dx = clickX - cx;
    const dy = clickY - cy;
    const distance = (dx * dx) + (dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestZone = zone;
    }
  }

  return {
    x: bestZone.x,
    y: bestZone.y,
    width: bestZone.width,
    height: bestZone.height,
    startBeat: bestZone.beatStart,
    endBeat: bestZone.beatStart + bestZone.beatDuration,
  };
}

export function beatFromClick(zones: MeasureHitZone[], clickX: number, clickY: number): number | null {
  const bestZone = measureBoundaryFromPoint(zones, clickX, clickY);
  if (!bestZone) return null;

  const relativeX = Math.max(0, Math.min(1, (clickX - bestZone.x) / bestZone.width));
  return bestZone.startBeat + ((bestZone.endBeat - bestZone.startBeat) * relativeX);
}
