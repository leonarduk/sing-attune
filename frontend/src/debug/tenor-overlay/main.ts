/**
 * Entry point for the tenor bass-clef / transposed-treble overlay debug
 * view (#360).
 *
 * Deliberately NOT registered in ../../registry.ts / index.html — this is a
 * developer/validation-only tool, reached only by navigating directly to
 * debug-tenor-overlay.html (see #360 AC: "not reachable from the default
 * practice UI"). It is a separate Vite HTML entry point for exactly that
 * reason: adding a slot to the practice page's index.html would make it
 * reachable from the normal rehearsal flow, which the issue explicitly
 * rules out.
 */
import type { ScoreModel } from '../../score/renderer';
import {
  compareTenorVersions,
  deriveOffsetNotes,
  EXPECTED_OCTAVE_OFFSET_SEMITONES,
  filterNotesInBarRange,
  type OverlayNote,
} from '../../pitch/tenor-overlay-compare';
import { formatOverlayReadout } from './tenor-overlay-readout';
import { TenorOverlayCanvas } from './tenor-overlay-view';

let scoreModel: ScoreModel | null = null;
let overlayCanvas: TenorOverlayCanvas | null = null;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

async function loadScore(file: File): Promise<ScoreModel> {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch('/score', { method: 'POST', body: form });
  if (!resp.ok) {
    let detail: string;
    try {
      detail = ((await resp.json()) as { detail?: string }).detail ?? resp.statusText;
    } catch {
      detail = resp.statusText;
    }
    throw new Error(`Score parse failed (HTTP ${resp.status}): ${detail}`);
  }
  return (await resp.json()) as ScoreModel;
}

function runComparison(): void {
  const statusEl = byId<HTMLDivElement>('status');
  const readoutEl = byId<HTMLPreElement>('readout');
  const partInput = byId<HTMLInputElement>('part-name');
  const startBarInput = byId<HTMLInputElement>('start-bar');
  const endBarInput = byId<HTMLInputElement>('end-bar');
  const offsetInput = byId<HTMLInputElement>('octave-offset');

  if (!scoreModel) {
    statusEl.textContent = 'Load a score file first.';
    return;
  }

  const partName = partInput.value.trim() || 'Tenor';
  const startBar = Number.parseInt(startBarInput.value, 10) || 0;
  const endBar = Number.parseInt(endBarInput.value, 10) || 0;
  const offset = Number.parseInt(offsetInput.value, 10);
  const offsetSemitones = Number.isFinite(offset) ? offset : EXPECTED_OCTAVE_OFFSET_SEMITONES;

  const bassNotes: OverlayNote[] = filterNotesInBarRange(scoreModel.notes, partName, startBar, endBar);
  const trebleNotes = deriveOffsetNotes(bassNotes, offsetSemitones);
  const comparison = compareTenorVersions(bassNotes, trebleNotes);

  readoutEl.textContent = formatOverlayReadout(comparison, partName, startBar, endBar);
  readoutEl.dataset.state = comparison.equivalent ? 'pass' : 'fail';

  overlayCanvas?.render({
    bassNotes,
    trebleNotes,
    comparison,
    partName,
    startBar,
    endBar,
  });

  statusEl.textContent = `Compared ${bassNotes.length} bass-clef note(s) against ${trebleNotes.length} transposed-treble note(s).`;
}

function mount(): void {
  const canvasContainer = byId<HTMLDivElement>('overlay-canvas');
  overlayCanvas = new TenorOverlayCanvas(canvasContainer);

  const fileInput = byId<HTMLInputElement>('file-input');
  const statusEl = byId<HTMLDivElement>('status');
  const compareButton = byId<HTMLButtonElement>('compare-button');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    statusEl.textContent = 'Parsing score…';
    loadScore(file)
      .then((model) => {
        scoreModel = model;
        statusEl.textContent = `Loaded "${model.title}" — parts: ${model.parts.join(', ')}`;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        statusEl.textContent = `Failed to load score: ${message}`;
      });
  });

  compareButton.addEventListener('click', () => {
    try {
      runComparison();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusEl.textContent = `Comparison failed: ${message}`;
    }
  });
}

mount();
