import { type Feature } from '../../feature-types';

const STORAGE_KEY = 'sing-attune.onboarding.dismissed.v1';

function hasDismissedWelcome(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setDismissedWelcome(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    // Ignore storage failures; the banner will simply reappear next time.
  }
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = `
    <section id="welcome-banner" class="welcome-banner hidden" aria-label="Getting started guide">
      <div class="welcome-banner__content">
        <div>
          <p class="welcome-banner__eyebrow">Welcome to sing-attune</p>
          <h2>Get from score upload to rehearsal in a few steps.</h2>
          <p class="welcome-banner__summary">
            Upload a MusicXML score (.xml or .mxl), pick your part, set up your microphone,
            warm up if you want, then press Play and sing along while the pitch graph and
            phrase summary show how closely you match the written notes.
          </p>
        </div>
        <ol class="welcome-banner__steps">
          <li><strong>Upload score:</strong> browse for a MusicXML <code>.xml</code> or <code>.mxl</code> file.</li>
          <li><strong>Set rehearsal controls:</strong> choose your part, optionally show all parts, and adjust transpose or tempo.</li>
          <li><strong>Check audio:</strong> use headphones, choose a mic in Settings, and warm up before rehearsal.</li>
          <li><strong>Review feedback:</strong> watch the pitch graph live, then use Phrase summary and Audio transcription after practice.</li>
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

  helpBtn?.addEventListener('click', () => {
    showBanner();
  });
}

export const onboardingFeature: Feature = {
  id: 'slot-onboarding',
  mount,
};
