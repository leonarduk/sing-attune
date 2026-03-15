import { type Feature } from '../../feature-types';
import { getMixerGroup, type MixerGroup } from '../../part-options';
import { getSession, onPartChanged, onScoreCleared, onScoreLoaded } from '../../services/score-session';

type MixerState = Record<MixerGroup, number>;

const STORAGE_KEY = 'sing-attune.part-mixer.v1';
const DEFAULT_MIXER_STATE: MixerState = {
  'my-part': 0.8,
  'other-vocals': 0.3,
  accompaniment: 0.5,
};

let removeKeydownListener: (() => void) | null = null;
let unsubscribeLoaded: (() => void) | null = null;
let unsubscribePartChanged: (() => void) | null = null;
let unsubscribeCleared: (() => void) | null = null;

function readState(): MixerState {
  const fallback = { ...DEFAULT_MIXER_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<MixerState>;
    for (const key of Object.keys(fallback) as MixerGroup[]) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        fallback[key] = Math.max(0, Math.min(1, value));
      }
    }
  } catch {
    // Ignore malformed storage and use defaults.
  }
  return fallback;
}

function saveState(state: MixerState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyMixer(state: MixerState): void {
  const session = getSession();
  if (!session) return;
  for (const part of session.model.parts) {
    const group = getMixerGroup(part, session.selectedPart);
    session.engine.setPartGain(part, state[group]);
  }
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = `
    <section id="part-mixer" class="mixer-panel hidden" aria-label="Part balance mixer">
      <div class="mixer-header">
        <strong>Part mixer</strong>
        <span class="mixer-hint">Press M to toggle</span>
      </div>
      <label for="mixer-my-part">My part <span id="mixer-my-part-label"></span></label>
      <input id="mixer-my-part" type="range" min="0" max="100" step="1" />
      <label for="mixer-other-vocals">Other vocal parts <span id="mixer-other-vocals-label"></span></label>
      <input id="mixer-other-vocals" type="range" min="0" max="100" step="1" />
      <label for="mixer-accompaniment">Accompaniment <span id="mixer-accompaniment-label"></span></label>
      <input id="mixer-accompaniment" type="range" min="0" max="100" step="1" />
    </section>
  `;

  const panel = document.getElementById('part-mixer') as HTMLElement;
  const sliderMap: Record<MixerGroup, HTMLInputElement> = {
    'my-part': document.getElementById('mixer-my-part') as HTMLInputElement,
    'other-vocals': document.getElementById('mixer-other-vocals') as HTMLInputElement,
    accompaniment: document.getElementById('mixer-accompaniment') as HTMLInputElement,
  };
  const labelMap: Record<MixerGroup, HTMLElement> = {
    'my-part': document.getElementById('mixer-my-part-label') as HTMLElement,
    'other-vocals': document.getElementById('mixer-other-vocals-label') as HTMLElement,
    accompaniment: document.getElementById('mixer-accompaniment-label') as HTMLElement,
  };

  const state = readState();

  function syncSliderLabels(): void {
    for (const key of Object.keys(state) as MixerGroup[]) {
      labelMap[key].textContent = `${Math.round(state[key] * 100)}%`;
      sliderMap[key].value = String(Math.round(state[key] * 100));
    }
  }

  function setEnabled(enabled: boolean): void {
    for (const key of Object.keys(sliderMap) as MixerGroup[]) {
      sliderMap[key].disabled = !enabled;
    }
  }

  syncSliderLabels();
  setEnabled(false);

  for (const key of Object.keys(sliderMap) as MixerGroup[]) {
    sliderMap[key].addEventListener('input', () => {
      state[key] = Number.parseFloat(sliderMap[key].value) / 100;
      syncSliderLabels();
      saveState(state);
      applyMixer(state);
    });
  }

  unsubscribeLoaded?.();
  unsubscribePartChanged?.();
  unsubscribeCleared?.();
  unsubscribeLoaded = onScoreLoaded(() => {
    setEnabled(true);
    applyMixer(state);
  });
  unsubscribePartChanged = onPartChanged(() => {
    applyMixer(state);
  });
  unsubscribeCleared = onScoreCleared(() => {
    setEnabled(false);
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.code !== 'KeyM') return;
    event.preventDefault();
    panel.classList.toggle('hidden');
  };
  window.addEventListener('keydown', onKeydown);
  removeKeydownListener = () => {
    window.removeEventListener('keydown', onKeydown);
  };
}

function unmount(): void {
  removeKeydownListener?.();
  removeKeydownListener = null;
  unsubscribeLoaded?.();
  unsubscribeLoaded = null;
  unsubscribePartChanged?.();
  unsubscribePartChanged = null;
  unsubscribeCleared?.();
  unsubscribeCleared = null;
}

export const partMixerFeature: Feature = {
  id: 'slot-part-mixer',
  mount,
  unmount,
};
