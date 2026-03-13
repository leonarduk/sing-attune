import { describe, expect, it } from 'vitest';
import { resolveSelectedDeviceId, type AudioInputDevice } from './devices';

const devices: AudioInputDevice[] = [
  { id: 10, name: 'Mic 1' },
  { id: 22, name: 'Mic 2' },
];

describe('resolveSelectedDeviceId', () => {
  it('prefers a persisted device that still exists', () => {
    expect(resolveSelectedDeviceId({
      devices,
      defaultDeviceId: 10,
      persistedDeviceId: 22,
    })).toBe(22);
  });

  it('falls back to backend default when persisted device is stale', () => {
    expect(resolveSelectedDeviceId({
      devices,
      defaultDeviceId: 10,
      persistedDeviceId: 999,
    })).toBe(10);
  });

  it('falls back to first listed mic when no default is provided', () => {
    expect(resolveSelectedDeviceId({
      devices,
      defaultDeviceId: null,
      persistedDeviceId: null,
    })).toBe(10);
  });

  it('returns null when no input devices are available', () => {
    expect(resolveSelectedDeviceId({
      devices: [],
      defaultDeviceId: null,
      persistedDeviceId: 22,
    })).toBeNull();
  });
});
