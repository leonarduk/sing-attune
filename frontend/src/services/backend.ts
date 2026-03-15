/**
 * Backend connectivity helpers.
 *
 * Centralises health-check logic and error banner updates.
 */

import { setAppStatus } from './status';

const errorBannerEl = document.getElementById('error-banner') as HTMLDivElement;
const errorBannerMessageEl = document.getElementById('error-banner-message') as HTMLSpanElement | null;
const errorBannerDismissEl = document.getElementById('error-banner-dismiss') as HTMLButtonElement | null;

type ShowErrorBannerOptions = {
  dismissible?: boolean;
};

if (errorBannerDismissEl) {
  errorBannerDismissEl.addEventListener('click', () => {
    clearErrorBanner();
  });
}

export function showErrorBanner(message: string, options: ShowErrorBannerOptions = {}): void {
  const { dismissible = false } = options;

  if (errorBannerMessageEl) {
    errorBannerMessageEl.textContent = message;
  } else {
    errorBannerEl.textContent = message;
  }

  if (errorBannerDismissEl) {
    errorBannerDismissEl.classList.toggle('hidden', !dismissible);
  }

  errorBannerEl.classList.add('visible');
}

export function clearErrorBanner(): void {
  if (errorBannerMessageEl) {
    errorBannerMessageEl.textContent = '';
  } else {
    errorBannerEl.textContent = '';
  }

  if (errorBannerDismissEl) {
    errorBannerDismissEl.classList.add('hidden');
  }

  errorBannerEl.classList.remove('visible');
}

export async function checkBackend(): Promise<void> {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version: string };
    clearErrorBanner();
    setAppStatus(`backend ok (v${data.version})`, 'success');
  } catch (err) {
    showErrorBanner('Cannot reach backend. Start backend and refresh the page.');
    setAppStatus('backend unreachable', 'error');
    console.error('Backend health check failed:', err);
  }
}
