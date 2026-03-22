import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtml = readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');

describe('settings panel shell', () => {
  it('shows the active pitch engine before the grouped settings sections', () => {
    const engineIndex = indexHtml.indexOf('id="settings-engine"');
    const userSettingsIndex = indexHtml.indexOf('id="settings-user-title"');
    const advancedIndex = indexHtml.indexOf('Advanced / Developer settings');

    expect(engineIndex).toBeGreaterThanOrEqual(0);
    expect(userSettingsIndex).toBeGreaterThan(engineIndex);
    expect(advancedIndex).toBeGreaterThan(userSettingsIndex);
  });

  it('adds explanatory tooltips to every issue-308 settings control', () => {
    const expectedIds = [
      'settings-device',
      'settings-confidence',
      'settings-trail',
      'settings-stable-confidence',
      'settings-stable-cluster',
      'settings-stable-hold',
      'settings-stable-window',
      'settings-show-note-names',
      'settings-synthetic-mode',
      'settings-force-cpu',
      'recording-enabled',
    ];

    for (const id of expectedIds) {
      expect(indexHtml).toMatch(new RegExp(`id="${id}"[^>]*title="[^"]+"`));
    }
  });


  it('moves developer actions into a dedicated tools dropdown in the sidebar', () => {
    expect(indexHtml).toContain('<details id="toolbar-tools" class="toolbar-details">');
    expect(indexHtml).toContain('<summary title="Show developer and diagnostic tools">Tools ▾</summary>');

    const toolsIndex = indexHtml.indexOf('id="toolbar-tools"');
    const diagnosticsIndex = indexHtml.indexOf('id="btn-diagnostics"');
    const loadTestIndex = indexHtml.indexOf('id="btn-load-test-score"');
    const settingsIndex = indexHtml.indexOf('id="btn-settings"');

    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(diagnosticsIndex).toBeGreaterThan(toolsIndex);
    expect(loadTestIndex).toBeGreaterThan(toolsIndex);
    expect(settingsIndex).toBeGreaterThan(diagnosticsIndex);
  });

  it('keeps advanced controls inside a collapsible details section', () => {
    expect(indexHtml).toContain('<details>');
    expect(indexHtml).toContain('<summary>Advanced / Developer settings</summary>');
  });

  it('keeps warm-up controls inside a collapsed disclosure by default', () => {
    expect(indexHtml).toContain('<details id="warmup-panel" class="warmup-panel">');
    expect(indexHtml).toContain('<summary>Warm-up</summary>');
  });
});
