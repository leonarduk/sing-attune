import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoreSession } from './score-session';

const mocks = vi.hoisted(() => ({
  setPlaybackTempo: vi.fn(async (_tempo: number) => ({})),
  setAppStatus: vi.fn(),
  getSession: vi.fn((): ScoreSession | null => null),
  setTempoMultiplier: vi.fn(),
}));

vi.mock('./score-session', () => ({
  getSession: mocks.getSession,
}));

vi.mock('./status', () => ({
  setAppStatus: mocks.setAppStatus,
}));

vi.mock('../transport/controls', () => ({
  setPlaybackTempo: mocks.setPlaybackTempo,
}));

import { applyTempoChange } from './tempo';

describe('applyTempoChange', () => {
  beforeEach(() => {
    mocks.setPlaybackTempo.mockReset();
    mocks.setPlaybackTempo.mockImplementation(async () => ({}));
    mocks.setAppStatus.mockReset();
    mocks.setTempoMultiplier.mockReset();
    mocks.getSession.mockReset();

    document.body.innerHTML = `
      <input id="tempo-slider" value="100" />
      <span id="tempo-label">100%</span>
    `;

    mocks.getSession.mockReturnValue({
      engine: {
        tempoMultiplier: 1,
        setTempoMultiplier: mocks.setTempoMultiplier,
      },
    } as unknown as ScoreSession);
  });

  it('clamps the tempo percent and syncs backend', async () => {
    await applyTempoChange(130);

    const slider = document.getElementById('tempo-slider') as HTMLInputElement;
    const label = document.getElementById('tempo-label') as HTMLSpanElement;

    expect(slider.value).toBe('125');
    expect(label.textContent).toBe('125%');
    expect(mocks.setTempoMultiplier).toHaveBeenCalledWith(1.25);
    expect(mocks.setPlaybackTempo).toHaveBeenCalledWith(1.25);
  });

  it('rolls back engine and UI on backend sync failure', async () => {
    const error = new Error('boom');
    mocks.setPlaybackTempo.mockRejectedValueOnce(error);

    await applyTempoChange(90);

    const slider = document.getElementById('tempo-slider') as HTMLInputElement;
    const label = document.getElementById('tempo-label') as HTMLSpanElement;

    expect(mocks.setTempoMultiplier).toHaveBeenNthCalledWith(1, 0.9);
    expect(mocks.setTempoMultiplier).toHaveBeenNthCalledWith(2, 1);
    expect(slider.value).toBe('100');
    expect(label.textContent).toBe('100%');
    expect(mocks.setAppStatus).toHaveBeenCalledWith('tempo update failed: Error: boom', 'error');
  });

  it('does nothing when no session exists', async () => {
    mocks.getSession.mockReturnValueOnce(null);

    await applyTempoChange(120);

    const slider = document.getElementById('tempo-slider') as HTMLInputElement;
    const label = document.getElementById('tempo-label') as HTMLSpanElement;

    expect(slider.value).toBe('100');
    expect(label.textContent).toBe('100%');
    expect(mocks.setTempoMultiplier).not.toHaveBeenCalled();
    expect(mocks.setPlaybackTempo).not.toHaveBeenCalled();
  });
});
