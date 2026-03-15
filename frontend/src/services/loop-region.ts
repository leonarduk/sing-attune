export interface LoopRegion {
  startBeat: number;
  endBeat: number;
  active: boolean;
}

type LoopRegionListener = (region: LoopRegion) => void;

const listeners = new Set<LoopRegionListener>();

let region: LoopRegion = {
  startBeat: 0,
  endBeat: 0,
  active: false,
};

function notify(): void {
  for (const listener of listeners) listener(region);
}

export function getLoopRegion(): LoopRegion {
  return region;
}

export function setLoopStart(startBeat: number): void {
  if (!Number.isFinite(startBeat) || startBeat < 0) return;
  const previousEnd = region.endBeat;
  region = {
    startBeat,
    endBeat: Math.max(startBeat, previousEnd),
    active: previousEnd > startBeat,
  };
  notify();
}

export function setLoopEnd(endBeat: number): void {
  if (!Number.isFinite(endBeat) || endBeat < 0) return;
  const startBeat = region.startBeat;
  region = {
    startBeat,
    endBeat,
    active: endBeat > startBeat,
  };
  notify();
}

export function clearLoopRegion(): void {
  if (!region.active && region.startBeat === 0 && region.endBeat === 0) return;
  region = {
    startBeat: 0,
    endBeat: 0,
    active: false,
  };
  notify();
}

export function onLoopRegionChanged(listener: LoopRegionListener): () => void {
  listeners.add(listener);
  listener(region);
  return () => {
    listeners.delete(listener);
  };
}
