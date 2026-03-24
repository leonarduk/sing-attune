import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('backend error banner', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = [
      '<div id="error-banner" role="alert">',
      '  <span id="error-banner-message"></span>',
      '  <button id="error-banner-action" class="hidden">Retry</button>',
      '  <button id="error-banner-dismiss" class="hidden">Dismiss</button>',
      '</div>',
    ].join('');
  });

  it('shows a dismiss button for dismissible banners and clears on click', async () => {
    const backend = await import('./backend');

    backend.showErrorBanner('Soundfont failed to load', { dismissible: true });

    const banner = document.getElementById('error-banner') as HTMLDivElement;
    const message = document.getElementById('error-banner-message') as HTMLSpanElement;
    const dismiss = document.getElementById('error-banner-dismiss') as HTMLButtonElement;

    expect(banner.classList.contains('visible')).toBe(true);
    expect(message.textContent).toBe('Soundfont failed to load');
    expect(dismiss.classList.contains('hidden')).toBe(false);

    dismiss.click();
    expect(banner.classList.contains('visible')).toBe(false);
    expect(message.textContent).toBe('');
  });

  it('keeps dismiss button hidden for non-dismissible banners', async () => {
    const backend = await import('./backend');

    backend.showErrorBanner('Cannot reach backend');

    const dismiss = document.getElementById('error-banner-dismiss') as HTMLButtonElement;
    expect(dismiss.classList.contains('hidden')).toBe(true);
  });

  it('shows an action button and calls the action handler when clicked', async () => {
    const backend = await import('./backend');
    const onRetry = vi.fn();

    backend.showErrorBanner('Soundfont failed to load', {
      dismissible: true,
      actionLabel: 'Retry',
      onAction: onRetry,
    });

    const action = document.getElementById('error-banner-action') as HTMLButtonElement;
    expect(action.classList.contains('hidden')).toBe(false);
    expect(action.textContent).toBe('Retry');

    action.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('marks backend as healthy when /health returns a version', async () => {
    const setAppStatusMock = vi.fn();
    vi.doMock('./status', () => ({
      setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', version: '0.2.0' }),
    }));

    const backend = await import('./backend');
    await backend.checkBackend();

    expect(setAppStatusMock).toHaveBeenCalledWith('backend ok (v0.2.0)', 'success');
    expect(document.getElementById('error-banner')?.classList.contains('visible')).toBe(false);
  });

  it('shows a clear startup message when /health is not sing-attune', async () => {
    const setAppStatusMock = vi.fn();
    vi.doMock('./status', () => ({
      setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', env: 'local' }),
    }));

    const backend = await import('./backend');
    await backend.checkBackend();

    expect(setAppStatusMock).toHaveBeenCalledWith('backend unreachable', 'error');
    expect(document.getElementById('error-banner-message')?.textContent).toContain(
      'Backend not available — please start the sing-attune backend on port 8000 and refresh.',
    );
  });
});
