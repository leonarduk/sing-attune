import { describe, expect, it } from 'vitest';
import { nextRecordingState } from './recorder';

describe('nextRecordingState', () => {
  it('transitions idle -> recording -> recorded -> idle', () => {
    const recording = nextRecordingState('idle', { type: 'start' });
    expect(recording).toBe('recording');

    const recorded = nextRecordingState(recording, { type: 'stop' });
    expect(recorded).toBe('recorded');

    const idle = nextRecordingState(recorded, { type: 'discard' });
    expect(idle).toBe('idle');
  });

  it('ignores stop when not currently recording', () => {
    expect(nextRecordingState('idle', { type: 'stop' })).toBe('idle');
    expect(nextRecordingState('recorded', { type: 'stop' })).toBe('recorded');
  });
});
