/**
 * Backend connectivity helpers.
 *
 * Centralises health-check logic, error banner updates, and backend URL
 * resolution.
 */

import { setAppStatus } from './status';

/**
 * Fixed origin of the backend the packaged Electron app spawns.
 *
 * Matches backend/main.py's hardcoded uvicorn bind (see the
 * `if __name__ == "__main__"` block: host="127.0.0.1", port=8000) — the
 * backend does not parse a --host/--port CLI flag or read a port env var,
 * so this can't negotiate a free port at runtime; it has to match the one
 * fixed address the backend actually listens on.
 */
const ELECTRON_BACKEND_HOST = '127.0.0.1';
const ELECTRON_BACKEND_PORT = 8000;

/**
 * True when running as the packaged Electron app's renderer.
 *
 * frontend/electron/main.js loads the built app via loadFile() (a file://
 * origin — see issue #436), not loadURL(), so a root-relative
 * fetch('/health') would resolve to file:///health and fail outright (the
 * file: scheme has no host to route the request to). Detect that case by
 * protocol and target the backend's origin explicitly instead; every other
 * context (Vite dev server on :5173 with its API proxy, or a same-origin
 * production host) keeps working exactly as before via the root-relative
 * fallback.
 */
function isElectronFileOrigin(): boolean {
  return window.location.protocol === 'file:';
}

/**
 * Resolve a root-relative backend API path (e.g. '/health') to a fetchable
 * URL for the current context. See isElectronFileOrigin().
 */
export function apiUrl(path: string): string {
  return isElectronFileOrigin() ? `http://${ELECTRON_BACKEND_HOST}:${ELECTRON_BACKEND_PORT}${path}` : path;
}

/**
 * WebSocket equivalent of apiUrl(), for the /ws/pitch stream. Outside of
 * Electron this reproduces the previous inline
 * `${protocol}://${window.location.host}/ws/pitch` construction so
 * behaviour on http/https origins is unchanged.
 */
export function wsUrl(path: string): string {
  if (isElectronFileOrigin()) {
    return `ws://${ELECTRON_BACKEND_HOST}:${ELECTRON_BACKEND_PORT}${path}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}${path}`;
}

// Typed `| null` and guarded like its siblings below: an absent/renamed
// #error-banner must degrade quietly instead of throwing on every
// showErrorBanner()/clearErrorBanner() call (issue #440).
const errorBannerEl = document.getElementById('error-banner') as HTMLDivElement | null;
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
  } else if (errorBannerEl) {
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

  errorBannerEl?.classList.add('visible');
}

export function clearErrorBanner(): void {
  if (errorBannerMessageEl) {
    errorBannerMessageEl.textContent = '';
  } else if (errorBannerEl) {
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

  errorBannerEl?.classList.remove('visible');
}

export async function checkBackend(): Promise<void> {
  try {
    const res = await fetch(apiUrl('/health'));
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
