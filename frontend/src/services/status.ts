export type StatusTone = 'info' | 'success' | 'warning' | 'error';

export function setAppStatus(message: string, tone: StatusTone = 'info'): void {
  const el = document.getElementById('app-status-text') as HTMLSpanElement | null;
  if (!el) {
    return;
  }

  el.textContent = message;
  el.dataset.tone = tone;
}
