import { describe, expect, it } from 'vitest';
import { parsePitchFrame, parsePitchSocketMessage, reconnectDelayMs } from './socket';

describe('reconnectDelayMs', () => {
  it('uses exponential backoff capped at max delay', () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(2000);
    expect(reconnectDelayMs(4)).toBe(4000);
    expect(reconnectDelayMs(5)).toBe(5000);
    expect(reconnectDelayMs(8)).toBe(5000);
  });
});

describe('parsePitchFrame', () => {
  it('accepts valid numeric frames', () => {
    expect(parsePitchFrame({ v: 1, t: 0.1, midi: 60, conf: 0.8 })).toEqual({ v: 1, t: 0.1, midi: 60, conf: 0.8 });
  });

  it('rejects malformed payloads', () => {
    expect(parsePitchFrame(null)).toBeNull();
    expect(parsePitchFrame({})).toBeNull();
    expect(parsePitchFrame({ v: 1, t: '0.1', midi: 60, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ v: 1, t: 0.1, midi: 60 })).toBeNull();
    expect(parsePitchFrame({ t: 0.1, midi: 60, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ v: 2, t: 0.1, midi: 60, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ v: 1, t: Number.NaN, midi: 60, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ v: 1, t: 0.1, midi: 128, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ v: 1, t: 0.1, midi: 60, conf: 1.1 })).toBeNull();
  });
});

describe('parsePitchSocketMessage', () => {
  it('classifies control messages', () => {
    expect(parsePitchSocketMessage({ status: 'connected' })).toEqual({ kind: 'status' });
    expect(parsePitchSocketMessage({ ping: true })).toEqual({ kind: 'ping' });
  });

  it('returns frame messages for valid pitch payloads', () => {
    expect(parsePitchSocketMessage({ v: 1, t: 100, midi: 60.2, conf: 0.9 })).toEqual({
      kind: 'frame',
      frame: { v: 1, t: 100, midi: 60.2, conf: 0.9 },
    });
  });

  it('classifies malformed payloads as unknown', () => {
    expect(parsePitchSocketMessage('abc')).toEqual({ kind: 'unknown' });
    expect(parsePitchSocketMessage({ ping: 'true' })).toEqual({ kind: 'unknown' });
    expect(parsePitchSocketMessage({ status: 'ok' })).toEqual({ kind: 'unknown' });
  });
});
