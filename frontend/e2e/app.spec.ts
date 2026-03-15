import { expect, test } from '@playwright/test';

const scoreModel = {
  title: 'E2E Mock Score',
  parts: ['Soprano'],
  notes: [
    { midi: 60, beat_start: 0, duration: 4, measure: 1, part: 'Soprano', lyric: null },
  ],
  tempo_marks: [{ beat: 0, bpm: 120 }],
  time_signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
  total_beats: 8,
};

test('load -> play -> pause with mocked backend and no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.route('**/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'e2e' }) });
  });

  await page.route('**/score', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scoreModel) });
  });

  await page.route('**/audio/devices', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        devices: [{ id: 1, name: 'Mock Mic', is_default: true }],
        default_device_id: 1,
      }),
    });
  });

  await page.route('**/audio/engine', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ backend: 'mock' }) });
  });

  await page.route('**/playback/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ t_ms: 0 }) });
  });

  await page.route('https://gleitz.github.io/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'MIDI.Soundfont.acoustic_grand_piano = {};',
    });
  });

  await page.goto('/');

  await expect(page.locator('#btn-play')).toBeDisabled();

  await page.locator('#file-input').setInputFiles('../musescore/One Day More satb_compressed.mxl');

  await expect(page.locator('#score-info')).toContainText('E2E Mock Score');
  await expect(page.locator('#btn-play')).toBeEnabled();

  await page.locator('#btn-play').click();

  const startRehearsal = page.getByRole('button', { name: 'Start rehearsal' });
  if (await startRehearsal.isVisible()) {
    await startRehearsal.click();
  }

  await expect(page.locator('#btn-pause')).toBeEnabled();
  await expect(page.locator('#btn-pause')).toContainText('Pause');

  await page.locator('#btn-pause').click();

  await expect(page.locator('#btn-pause')).toContainText('Resume');
  await expect(page.locator('#btn-play')).toBeEnabled();

  expect(consoleErrors).toEqual([]);
});
