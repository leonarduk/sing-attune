import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('backend error banner', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = [
      '<div id="error-banner" role="alert">',
      '  <span id="error-banner-message"></span>',
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
});
