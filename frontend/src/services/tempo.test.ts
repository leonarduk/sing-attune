import { beforeEach, describe, expect, it, vi } from 'vitest';

const setPlaybackTempoMock = vi.fn(async () => ({}));
const setAppStatusMock = vi.fn();
const getSessionMock = vi.fn(() => null);
const setTempoMultiplierMock = vi.fn();

vi.mock('./score-session', () => ({
  getSession: () => getSessionMock(),
}));

vi.mock('./status', () => ({
  setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
}));

vi.mock('../transport/controls', () => ({
  setPlaybackTempo: (...args: unknown[]) => setPlaybackTempoMock(...args),
}));

import { applyTempoChange } from './tempo';

describe('applyTempoChange', () => {
  beforeEach(() => {
    setPlaybackTempoMock.mockReset();
    setPlaybackTempoMock.mockImplementation(async () => ({}));
    setAppStatusMock.mockReset();
    setTempoMultiplierMock.mockReset();
    getSessionMock.mockReset();

    document.body.innerHTML = `
      <input id="tempo-slider" value="100" />
      <span id="tempo-label">100%</span>
    `;

    getSessionMock.mockReturnValue({
      engine: {
        tempoMultiplier: 1,
        setTempoMultiplier: setTempoMultiplierMock,
      },
    });
  });

  it('clamps the tempo percent and syncs backend', async () => {
    await applyTempoChange(130);

    const slider = document.getElementById('tempo-slider') as HTMLInputElement;
    const label = document.getElementById('tempo-label') as HTMLSpanElement;

    expect(slider.value).toBe('125');
    expect(label.textContent).toBe('125%');
    expect(setTempoMultiplierMock).toHaveBeenCalledWith(1.25);
    expect(setPlaybackTempoMock).toHaveBeenCalledWith(1.25);
  });

  it('rolls back engine and UI on backend sync failure', async () => {
    const error = new Error('boom');
    setPlaybackTempoMock.mockRejectedValueOnce(error);

    await applyTempoChange(90);

    const slider = document.getElementById('tempo-slider') as HTMLInputElement;
    const label = document.getElementById('tempo-label') as HTMLSpanElement;

    expect(setTempoMultiplierMock).toHaveBeenNthCalledWith(1, 0.9);
    expect(setTempoMultiplierMock).toHaveBeenNthCalledWith(2, 1);
    expect(slider.value).toBe('100');
    expect(label.textContent).toBe('100%');
    expect(setAppStatusMock).toHaveBeenCalledWith('tempo update failed: Error: boom', 'error');
  });
});
