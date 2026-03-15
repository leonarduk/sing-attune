import { getSession } from './score-session';
import { setAppStatus } from './status';
import { setPlaybackTempo } from '../transport/controls';

function clampTempoPercent(percent: number): number {
  return Math.max(50, Math.min(125, percent));
}

function applyTempoUi(percent: number): void {
  const tempoSliderEl = document.getElementById('tempo-slider') as HTMLInputElement | null;
  const tempoLabelEl = document.getElementById('tempo-label') as HTMLSpanElement | null;
  if (!tempoSliderEl || !tempoLabelEl) return;

  const clampedPercent = clampTempoPercent(percent);
  tempoSliderEl.value = String(clampedPercent);
  tempoLabelEl.textContent = `${clampedPercent}%`;
}

export async function applyTempoChange(percent: number): Promise<void> {
  const session = getSession();
  if (!session) return;

  const { engine } = session;
  const previousMultiplier = engine.tempoMultiplier;
  const clampedPercent = clampTempoPercent(percent);
  const nextMultiplier = clampedPercent / 100;

  applyTempoUi(clampedPercent);
  engine.setTempoMultiplier(nextMultiplier);
  try {
    await setPlaybackTempo(nextMultiplier);
  } catch (err) {
    engine.setTempoMultiplier(previousMultiplier);
    applyTempoUi(Math.round(previousMultiplier * 100));
    setAppStatus(`tempo update failed: ${String(err)}`, 'error');
    console.error('Tempo update failed:', err);
  }
}
