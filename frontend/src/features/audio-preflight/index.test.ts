import { describe, expect, it } from 'vitest';
import { __audioPreflightInternals } from './index';

describe('audio preflight device selection', () => {
  it('returns null when no devices are available', () => {
    expect(__audioPreflightInternals.resolveSelectedDeviceId([], 'dev-1')).toBeNull();
  });

  it('keeps the selected device when it still exists', () => {
    const devices = [
      { deviceId: 'dev-1', label: 'Mic 1' },
      { deviceId: 'dev-2', label: 'Mic 2' },
    ];

    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, 'dev-2')).toBe('dev-2');
  });

  it('falls back to first available device when selected device is missing', () => {
    const devices = [
      { deviceId: 'dev-3', label: 'Mic 3' },
      { deviceId: 'dev-4', label: 'Mic 4' },
    ];

    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, 'missing')).toBe('dev-3');
    expect(__audioPreflightInternals.resolveSelectedDeviceId(devices, null)).toBe('dev-3');
  });
});
