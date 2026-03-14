/**
 * Backend connectivity helpers.
 *
 * Centralises health-check logic and the two status/banner update functions
 * so features do not need to reach into arbitrary DOM IDs.
 */

const statusEl = document.getElementById('status') as HTMLSpanElement;
const errorBannerEl = document.getElementById('error-banner') as HTMLDivElement;

export function setStatus(msg: string, cls: 'ok' | 'error' | 'loading' | ''): void {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

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
    setStatus(`backend ok (v${data.version})`, 'ok');
  } catch (err) {
    showErrorBanner('Cannot reach backend. Start backend and refresh the page.');
    setStatus('backend unreachable', 'error');
    console.error('Backend health check failed:', err);
  }
}
