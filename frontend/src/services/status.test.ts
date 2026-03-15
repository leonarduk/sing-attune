import { describe, expect, it } from 'vitest';
import { setAppStatus } from './status';

describe('setAppStatus', () => {
  it('updates message text and tone dataset', () => {
    document.body.innerHTML = '<span id="app-status-text">initial</span>';

    setAppStatus('Backend connected', 'success');

    const statusEl = document.getElementById('app-status-text') as HTMLSpanElement;
    expect(statusEl.textContent).toBe('Backend connected');
    expect(statusEl.dataset.tone).toBe('success');
  });

  it('does nothing when status element is missing', () => {
    document.body.innerHTML = '';

    expect(() => setAppStatus('Backend unreachable', 'error')).not.toThrow();
  });
});
