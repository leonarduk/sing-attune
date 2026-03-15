/**
 * part-selector feature
 *
 * Owns:
 *   - #part-select, #show-accompaniment
 *   - #transpose-select
 *   - #tempo-slider / #tempo-label
 *
 * Calls updateSelectedPart() on change so pitch-overlay can react without
 * a direct coupling between the two features.
 */
import { onScoreLoaded, onScoreCleared, getSession, updateSelectedPart } from '../../services/score-session';
import { setAppStatus } from '../../services/status';
import { getVisiblePartOptions } from '../../part-options';
import { setPlaybackTempo, setPlaybackTranspose } from '../../transport/controls';
import { type Feature } from '../../feature-types';

let unsubscribeScoreLoaded: (() => void) | null = null;
let unsubscribeScoreCleared: (() => void) | null = null;

function mount(_slot: HTMLElement): void {
  const partSelectEl      = document.getElementById('part-select')        as HTMLSelectElement;
  const showAccompEl      = document.getElementById('show-accompaniment') as HTMLInputElement;
  const transposeSelectEl = document.getElementById('transpose-select')   as HTMLSelectElement;
  const tempoSliderEl     = document.getElementById('tempo-slider')       as HTMLInputElement;
  const tempoLabelEl      = document.getElementById('tempo-label')        as HTMLSpanElement;


  function clampTempoPercent(percent: number): number {
    return Math.max(50, Math.min(125, percent));
  }

  function applyTempoUi(percent: number): void {
    const clampedPercent = clampTempoPercent(percent);
    tempoSliderEl.value = String(clampedPercent);
    tempoLabelEl.textContent = `${clampedPercent}%`;
  }

  async function commitTempoChange(nextPercent: number): Promise<void> {
    const session = getSession();
    if (!session) return;
    const { engine } = session;
    const previousMultiplier = engine.tempoMultiplier;
    const clampedPercent = clampTempoPercent(nextPercent);
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

  function getTransposeSemitones(): number {
    const parsed = parseInt(transposeSelectEl.value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function scheduleSelectedPart(selectedPart: string): void {
    const session = getSession();
    if (!session || !selectedPart) return;
    const { engine, renderer, model } = session;
    if (!model.parts.includes(selectedPart)) return;
    if (!model.notes.some((n) => n.part === selectedPart)) return;

    if (engine.state === 'playing') {
      engine.selectPart(selectedPart);
    } else {
      engine.schedule(
        model.notes, model.tempo_marks, selectedPart,
        parseFloat(tempoSliderEl.value) / 100,
      );
      engine.setTransposeSemitones(getTransposeSemitones());
    }
    renderer.setHighlightedPart(selectedPart);
  }

  function refreshPartSelector(): void {
    const session = getSession();
    if (!session) return;
    const allParts = session.model.parts;
    const selectedBefore = partSelectEl.value;
    const visibleParts = getVisiblePartOptions(allParts, showAccompEl.checked);
    partSelectEl.innerHTML = visibleParts
      .map((opt) => `<option value="${opt.name}">${opt.name}</option>`)
      .join('');
    const stillVisible = visibleParts.some((opt) => opt.name === selectedBefore);
    const selectedPart = stillVisible ? selectedBefore : (visibleParts[0]?.name ?? allParts[0] ?? '');
    partSelectEl.value = selectedPart;
    partSelectEl.disabled = visibleParts.length <= 1;
    scheduleSelectedPart(selectedPart);
    if (session.selectedPart !== selectedPart) updateSelectedPart(selectedPart);
  }

  unsubscribeScoreCleared?.();
  unsubscribeScoreLoaded?.();
  unsubscribeScoreCleared = onScoreCleared(() => { partSelectEl.innerHTML = ''; });
  unsubscribeScoreLoaded = onScoreLoaded(() => { refreshPartSelector(); });

  partSelectEl.addEventListener('change', () => {
    scheduleSelectedPart(partSelectEl.value);
    updateSelectedPart(partSelectEl.value);
  });

  showAccompEl.addEventListener('change', () => { refreshPartSelector(); });

  // Tempo
  applyTempoUi(parseInt(tempoSliderEl.value, 10));
  tempoSliderEl.addEventListener('input', () => {
    applyTempoUi(parseInt(tempoSliderEl.value, 10));
  });
  tempoSliderEl.addEventListener('change', () => {
    void commitTempoChange(parseInt(tempoSliderEl.value, 10));
  });

  // Transpose
  transposeSelectEl.addEventListener('change', async () => {
    const session = getSession();
    if (!session) return;
    const semitones = getTransposeSemitones();
    session.engine.setTransposeSemitones(semitones);
    session.renderer.applyVisualTranspose(semitones);
    try {
      await setPlaybackTranspose(semitones);
    } catch (err) {
      setAppStatus(`transpose sync failed: ${String(err)}`, 'error');
      console.error('Transpose sync failed:', err);
    }
  });
}

function unmount(): void {
  unsubscribeScoreCleared?.();
  unsubscribeScoreCleared = null;
  unsubscribeScoreLoaded?.();
  unsubscribeScoreLoaded = null;
}

export const partSelectorFeature: Feature = {
  id: 'slot-part-selector',
  mount,
  unmount,
};
