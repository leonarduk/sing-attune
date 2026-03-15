import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The /score mock must match ScoreModel exactly — score-loader uses the
// backend response (not OSMD) to populate #score-info and schedule notes.
const scoreModel = {
  title: 'E2E Mock Score',
  parts: ['Soprano'],
  notes: [
    { midi: 60, beat_start: 0, duration: 4, measure: 1, part: 'Soprano', lyric: null },
    { midi: 62, beat_start: 4, duration: 4, measure: 2, part: 'Soprano', lyric: null },
  ],
  tempo_marks: [{ beat: 0, bpm: 120 }],
  time_signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
  total_beats: 8,
};

// Known-benign errors that do not indicate a test failure.
// The pitch WebSocket always fails in E2E because there is no backend process.
const IGNORED_ERRORS = [
  '/ws/pitch',
];

test('load -> play -> pause with mocked backend and no console errors', async ({ page }) => {
  const consoleLogs: string[] = [];
  page.on('console', (message) => {
    consoleLogs.push(`[${message.type()}] ${message.text()}`);
  });

  // Match only exact-path backend routes to avoid intercepting Vite JS module requests.
  await page.route((url) => url.pathname === '/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'e2e' }) });
  });

  await page.route((url) => url.pathname === '/score', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scoreModel) });
  });

  await page.route((url) => url.pathname === '/audio/devices', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        devices: [{ id: 1, name: 'Mock Mic', is_default: true }],
        default_device_id: 1,
      }),
    });
  });

  await page.route((url) => url.pathname === '/audio/engine', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ backend: 'mock' }) });
  });

  await page.route((url) => url.pathname.startsWith('/playback/'), async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ t_ms: 0 }) });
  });

  await page.route('**/soundfonts/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'MIDI.Soundfont.acoustic_grand_piano = {};',
    });
  });

  await page.route('https://gleitz.github.io/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'MIDI.Soundfont.acoustic_grand_piano = {};',
    });
  });

  await page.route('https://cdn.jsdelivr.net/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'MIDI.Soundfont.acoustic_grand_piano = {};',
    });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Before file upload: score-info should be empty — no score loaded yet.
  await expect(page.locator('#score-info')).toHaveText('');

  // Use a plain .xml fixture — OSMD loads XML directly without unzipping.
  const fixturePath = path.resolve(__dirname, 'fixtures', 'minimal.xml');
  await page.locator('#file-input').setInputFiles(fixturePath);

  // Title comes from the /score mock response (ScoreModel.title), not OSMD.
  try {
    await expect(page.locator('#score-info')).toContainText('E2E Mock Score', { timeout: 15000 });
  } catch (e) {
    console.error('=== Browser console output ===');
    for (const log of consoleLogs) console.error(log);
    throw e;
  }

  await expect(page.locator('#btn-play')).toBeEnabled();

  await page.locator('#btn-play').click();

  // Clicking play opens the audio preflight modal (mic setup).
  // The "Allow microphone" button requests getUserMedia — fake media flags
  // in playwright.config.ts grant permission automatically.
  // Then click "Start rehearsal" to mark preflight complete and start playback.
  const preflightModal = page.locator('#audio-preflight-modal');
  if (await preflightModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    const requestMicButton = page.locator('#audio-preflight-request');
    if (await requestMicButton.isVisible().catch(() => false)) {
      await requestMicButton.click();
    }
    const startRehearsal = page.locator('#audio-preflight-continue');
    await expect(startRehearsal).toBeEnabled({ timeout: 5000 });
    await startRehearsal.click();
  }

  // #btn-start-rehearsal (warmup) is hidden by default.
  await expect(page.locator('#btn-start-rehearsal')).toBeHidden();

  await expect(page.locator('#btn-pause')).toBeEnabled({ timeout: 5000 });
  await expect(page.locator('#btn-pause')).toContainText('Pause');

  await page.locator('#btn-pause').click();

  await expect(page.locator('#btn-pause')).toContainText('Resume');
  await expect(page.locator('#btn-play')).toBeEnabled();

  // Filter out known-benign errors (pitch WebSocket fails without a backend process).
  const unexpectedErrors = consoleLogs
    .filter(l => l.startsWith('[error]'))
    .filter(l => !IGNORED_ERRORS.some(known => l.includes(known)));
  expect(unexpectedErrors).toEqual([]);
});
