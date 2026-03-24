/**
 * Backend connectivity helpers.
 *
 * Centralises health-check logic and error banner updates.
 */

import { setAppStatus } from './status';

const errorBannerEl = document.getElementById('error-banner') as HTMLDivElement;
const errorBannerMessageEl = document.getElementById('error-banner-message') as HTMLSpanElement | null;
const errorBannerActionEl = document.getElementById('error-banner-action') as HTMLButtonElement | null;
const errorBannerDismissEl = document.getElementById('error-banner-dismiss') as HTMLButtonElement | null;

type ShowErrorBannerOptions = {
  dismissible?: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

let errorBannerActionHandler: (() => void) | null = null;

if (errorBannerDismissEl) {
  errorBannerDismissEl.addEventListener('click', () => {
    clearErrorBanner();
  });
}

if (errorBannerActionEl) {
  errorBannerActionEl.addEventListener('click', () => {
    errorBannerActionHandler?.();
  });
}

export function showErrorBanner(message: string, options: ShowErrorBannerOptions = {}): void {
  const { dismissible = false, actionLabel, onAction } = options;

  if (errorBannerMessageEl) {
    errorBannerMessageEl.textContent = message;
  } else {
    errorBannerEl.textContent = message;
  }

  if (errorBannerDismissEl) {
    errorBannerDismissEl.classList.toggle('hidden', !dismissible);
  }

  if (errorBannerActionEl) {
    errorBannerActionHandler = onAction ?? null;
    if (actionLabel && onAction) {
      errorBannerActionEl.textContent = actionLabel;
      errorBannerActionEl.classList.remove('hidden');
    } else {
      errorBannerActionEl.classList.add('hidden');
      errorBannerActionEl.textContent = '';
    }
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

  if (errorBannerActionEl) {
    errorBannerActionEl.classList.add('hidden');
    errorBannerActionEl.textContent = '';
  }
  errorBannerActionHandler = null;

  errorBannerEl.classList.remove('visible');
}

export async function checkBackend(): Promise<void> {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version?: unknown };
    const version = typeof data.version === 'string' ? data.version : null;
    if (!version) {
      throw new Error('Unexpected /health response (missing version).');
    }
    clearErrorBanner();
    setAppStatus(`backend ok (v${version})`, 'success');
  } catch (err) {
    showErrorBanner('Backend not available — please start the sing-attune backend on port 8000 and refresh.');
    setAppStatus('backend unreachable', 'error');
    console.error('Backend health check failed:', err);
  }
}
