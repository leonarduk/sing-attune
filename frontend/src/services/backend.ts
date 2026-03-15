/**
 * Backend connectivity helpers.
 *
 * Centralises health-check logic and error banner updates.
 */

import { setAppStatus } from './status';

const errorBannerEl = document.getElementById('error-banner') as HTMLDivElement;

export function showErrorBanner(message: string): void {
  errorBannerEl.textContent = message;
  errorBannerEl.classList.add('visible');
}

export function clearErrorBanner(): void {
  errorBannerEl.textContent = '';
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
