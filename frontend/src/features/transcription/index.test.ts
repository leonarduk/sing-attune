import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAppStatusMock = vi.fn();
const showErrorBannerMock = vi.fn();
const clearErrorBannerMock = vi.fn();
const requestTranscriptionMock = vi.fn();
const createObjectUrlMock = vi.fn(() => 'blob:musicxml');

vi.mock('../../services/status', () => ({
  setAppStatus: (...args: unknown[]) => setAppStatusMock(...args),
}));

vi.mock('../../services/backend', () => ({
  showErrorBanner: (...args: unknown[]) => showErrorBannerMock(...args),
  clearErrorBanner: () => clearErrorBannerMock(),
}));

vi.mock('./transcription-api', async () => {
  const actual = await vi.importActual<typeof import('./transcription-api')>('./transcription-api');
  return {
    ...actual,
    requestTranscription: (...args: unknown[]) => requestTranscriptionMock(...args),
  };
});

import { transcriptionFeature } from './index';

function installDom(): void {
  document.body.innerHTML = [
    '<div id="slot-transcription"></div>',
    '<div id="error-banner"><span id="error-banner-message"></span><button id="error-banner-action" class="hidden"></button><button id="error-banner-dismiss" class="hidden"></button></div>',
  ].join('');
}

describe('transcriptionFeature', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installDom();
    vi.stubGlobal('URL', {
      createObjectURL: createObjectUrlMock,
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders parsed results after a successful transcription', async () => {
    requestTranscriptionMock.mockResolvedValue({
      musicxml: `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`,
      tempoBpm: 120,
      keySignature: 'C major',
    });

    const slot = document.getElementById('slot-transcription') as HTMLDivElement;
    transcriptionFeature.mount(slot);

    const input = document.getElementById('transcription-file-input') as HTMLInputElement;
    const file = new File(['wave'], 'take.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    const runBtn = document.getElementById('btn-transcription-run') as HTMLButtonElement;
    runBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestTranscriptionMock).toHaveBeenCalledWith(file);
    expect(setAppStatusMock).toHaveBeenLastCalledWith('transcription ready', 'success');
    expect(document.getElementById('transcription-result')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('transcription-summary')?.textContent).toContain('Notes: 1');
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect((document.getElementById('transcription-download') as HTMLAnchorElement).download).toBe('transcription.musicxml');
  });

  it('shows a validation error for unsupported files before calling the backend', () => {
    const slot = document.getElementById('slot-transcription') as HTMLDivElement;
    transcriptionFeature.mount(slot);

    const input = document.getElementById('transcription-file-input') as HTMLInputElement;
    const file = new File(['data'], 'take.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    const runBtn = document.getElementById('btn-transcription-run') as HTMLButtonElement;
    runBtn.click();

    expect(requestTranscriptionMock).not.toHaveBeenCalled();
    expect(showErrorBannerMock).toHaveBeenCalled();
    expect(document.getElementById('transcription-inline-error')?.textContent).toContain('Unsupported file type');
  });
});
