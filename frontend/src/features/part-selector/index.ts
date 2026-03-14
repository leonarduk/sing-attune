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
import { setStatus } from '../../services/backend';
import { getVisiblePartOptions } from '../../part-options';
import { setPlaybackTempo, setPlaybackTranspose } from '../../transport/controls';
import { type Feature } from '../../feature-types';

function mount(_slot: HTMLElement): void {
  const partSelectEl      = document.getElementById('part-select')        as HTMLSelectElement;
  const showAccompEl      = document.getElementById('show-accompaniment') as HTMLInputElement;
  const transposeSelectEl = document.getElementById('transpose-select')   as HTMLSelectElement;
  const tempoSliderEl     = document.getElementById('tempo-slider')       as HTMLInputElement;
  const tempoLabelEl      = document.getElementById('tempo-label')        as HTMLSpanElement;

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

  onScoreCleared(() => { partSelectEl.innerHTML = ''; });
  onScoreLoaded(() => { refreshPartSelector(); });

  partSelectEl.addEventListener('change', () => {
    scheduleSelectedPart(partSelectEl.value);
    updateSelectedPart(partSelectEl.value);
  });

  showAccompEl.addEventListener('change', () => { refreshPartSelector(); });

  // Tempo
  tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
  tempoSliderEl.addEventListener('input', () => {
    tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
  });
  tempoSliderEl.addEventListener('change', async () => {
    const session = getSession();
    if (!session) return;
    const { engine } = session;
    const previousMultiplier = engine.tempoMultiplier;
    const nextMultiplier = parseFloat(tempoSliderEl.value) / 100;
    engine.setTempoMultiplier(nextMultiplier);
    try {
      await setPlaybackTempo(nextMultiplier);
    } catch (err) {
      engine.setTempoMultiplier(previousMultiplier);
      tempoSliderEl.value = String(Math.round(previousMultiplier * 100));
      tempoLabelEl.textContent = `${tempoSliderEl.value}%`;
      setStatus(`tempo update failed: ${String(err)}`, 'error');
      console.error('Tempo update failed:', err);
    }
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
      setStatus(`transpose sync failed: ${String(err)}`, 'error');
      console.error('Transpose sync failed:', err);
    }
  });
}

function unmount(): void { /* stateless */ }

export const partSelectorFeature: Feature = {
  id: 'slot-part-selector',
  mount,
  unmount,
};
