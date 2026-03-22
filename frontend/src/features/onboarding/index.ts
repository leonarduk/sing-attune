import { type Feature } from '../../feature-types';

const STORAGE_KEY = 'sing-attune.onboarding.dismissed.v1';
const STORAGE_WARNING = '[onboarding] localStorage unavailable; showing the welcome guide each time.';

function warnStorageFailure(error: unknown): void {
  console.warn(STORAGE_WARNING, error);
}

function hasDismissedWelcome(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch (error) {
    warnStorageFailure(error);
    return false;
  }
}

function setDismissedWelcome(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, 'true');
  } catch (error) {
    warnStorageFailure(error);
  }
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = `
    <section id="welcome-banner" class="welcome-banner hidden" aria-label="Getting started guide">
      <div class="welcome-banner__content">
        <div>
          <p class="welcome-banner__eyebrow">Welcome to sing-attune</p>
          <h2>Load a score, select a part, then press Play to begin rehearsal.</h2>
          <p class="welcome-banner__summary">
            Upload a MusicXML score, pick the line you want to sing, and start playback when you are ready.
          </p>
        </div>
        <ol class="welcome-banner__steps">
          <li><strong>Load a score:</strong> drop or browse for a MusicXML file.</li>
          <li><strong>Select a part:</strong> choose the voice or instrument line you want to rehearse.</li>
          <li><strong>Press Play:</strong> start rehearsal, sing along, and watch the live pitch feedback.</li>
        </ol>
      </div>
      <div class="welcome-banner__actions">
        <button id="btn-welcome-dismiss" class="transport-btn">Dismiss welcome guide</button>
      </div>
    </section>
  `;

  const bannerEl = document.getElementById('welcome-banner') as HTMLElement;
  const dismissBtn = document.getElementById('btn-welcome-dismiss') as HTMLButtonElement;
  const helpBtn = document.getElementById('btn-help') as HTMLButtonElement | null;

  const showBanner = (): void => {
    bannerEl.classList.remove('hidden');
  };

  const hideBanner = (): void => {
    bannerEl.classList.add('hidden');
  };

  if (!hasDismissedWelcome()) {
    showBanner();
  }

  dismissBtn.addEventListener('click', () => {
    setDismissedWelcome();
    hideBanner();
  });

  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      showBanner();
    });
  }
}

export const onboardingFeature: Feature = {
  id: 'slot-onboarding',
  mount,
};
