/**
 * sing-attune entry point.
 *
 * This file is intentionally minimal and must never contain feature-specific
 * code. Adding a feature = add a directory under features/ and one line in
 * registry.ts. This file does not change.
 *
 * Boot sequence:
 *   1. Mount each registered feature into its DOM slot.
 *   2. Run backend health check (delegated to services/backend).
 *
 * Clock hierarchy (enforced in features/playback, must never be broken):
 *   AudioContext.currentTime → engine.currentBeat → cursor.seekToBeat()
 */
import { features } from './registry';
import { checkBackend } from './services/backend';

for (const feature of features) {
  const slot = document.getElementById(feature.id);
  if (slot) {
    feature.mount(slot);
  } else {
    console.warn(`[registry] DOM slot not found: #${feature.id}`);
  }
}

void checkBackend();
