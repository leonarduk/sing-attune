const activeToastKeys = new Set<string>();

export type ToastVariant = 'info' | 'warning';

export function showToast(
  message: string,
  options: {
    variant?: ToastVariant;
    durationMs?: number;
    dedupeKey?: string;
  } = {},
): void {
  const toastStackEl = document.getElementById('toast-stack') as HTMLDivElement | null;
  if (!toastStackEl) return;

  const { variant = 'info', durationMs = 4500, dedupeKey } = options;
  if (dedupeKey && activeToastKeys.has(dedupeKey)) return;

  if (dedupeKey) activeToastKeys.add(dedupeKey);

  const el = document.createElement('div');
  el.className = `toast ${variant === 'warning' ? 'warning' : ''}`.trim();
  el.textContent = message;
  toastStackEl.appendChild(el);

  window.setTimeout(() => {
    el.remove();
    if (dedupeKey) activeToastKeys.delete(dedupeKey);
  }, durationMs);
}
