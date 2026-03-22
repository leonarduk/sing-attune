import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onboardingFeature } from './index';

function installDom(includeHelpButton = true): void {
  document.body.innerHTML = `
    <div id="slot-onboarding"></div>
    ${includeHelpButton ? '<button id="btn-help">Help</button>' : ''}
  `;
}

describe('onboardingFeature', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('keeps onboarding usable when localStorage throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage offline');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage offline');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    onboardingFeature.mount(slot);

    const banner = document.getElementById('welcome-banner') as HTMLElement;
    expect(banner.classList.contains('hidden')).toBe(false);

    (document.getElementById('btn-welcome-dismiss') as HTMLButtonElement).click();

    expect(getItemSpy).toHaveBeenCalled();
    expect(setItemSpy).toHaveBeenCalledWith('sing-attune.onboarding.dismissed.v1', 'true');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('does not crash when the help button is absent', () => {
    installDom(false);

    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    expect(() => onboardingFeature.mount(slot)).not.toThrow();

    const banner = document.getElementById('welcome-banner') as HTMLElement;
    expect(banner.classList.contains('hidden')).toBe(false);
  });

  it('renders the core onboarding flow copy', () => {
    const slot = document.getElementById('slot-onboarding') as HTMLDivElement;
    onboardingFeature.mount(slot);

    const text = (document.getElementById('welcome-banner') as HTMLElement).textContent ?? '';
    expect(text).toContain('Load a score');
    expect(text).toContain('Select a part');
    expect(text).toContain('Press Play');
  });
});
