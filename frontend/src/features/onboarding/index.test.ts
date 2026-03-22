import { beforeEach, describe, expect, it } from 'vitest';

import { onboardingFeature } from './index';

function installDom(): void {
  document.body.innerHTML = `
    <div id="slot-onboarding"></div>
    <button id="btn-help">Help</button>
  `;
}

describe('onboardingFeature', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installDom();
  });

  it('shows the welcome banner for first-run users', () => {
    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    onboardingFeature.mount(slot);

    const banner = document.getElementById('welcome-banner') as HTMLElement;
    expect(banner.classList.contains('hidden')).toBe(false);
  });

  it('hides the welcome banner after dismiss and persists the preference', () => {
    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    onboardingFeature.mount(slot);

    const dismiss = document.getElementById('btn-welcome-dismiss') as HTMLButtonElement;
    dismiss.click();

    const banner = document.getElementById('welcome-banner') as HTMLElement;
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(window.localStorage.getItem('sing-attune.onboarding.dismissed.v1')).toBe('true');
  });

  it('lets the help button reopen the guide after dismissal', () => {
    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    onboardingFeature.mount(slot);

    (document.getElementById('btn-welcome-dismiss') as HTMLButtonElement).click();
    (document.getElementById('btn-help') as HTMLButtonElement).click();

    const banner = document.getElementById('welcome-banner') as HTMLElement;
    expect(banner.classList.contains('hidden')).toBe(false);
  });
});
