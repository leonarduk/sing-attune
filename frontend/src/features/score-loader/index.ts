/**
 * score-loader feature
 *
 * Owns:
 *   - Drop zone + file picker (#drop-zone, #file-input, #btn-browse)
 *   - Score metadata readout (#score-info)
 *   - Score container + loading spinner (#score-container, #score-loading)
 *   - Click-to-seek on the rendered score
 *
 * After a score loads it publishes a ScoreSession via setSession().
 * Before loading it calls clearSession() so other features can tear down.
 */
import { ScoreRenderer } from '../../score/renderer';
import { ScoreCursor } from '../../score/cursor';
import { PlaybackEngine } from '../../playback/engine';
import {
  getAudioContext,
  getSoundfont,
  ensureSoundfontLoaded,
  getSoundfontLoadPromise,
} from '../../services/audio-context';
import { setSession, clearSession, getSession } from '../../services/score-session';
import { setStatus, showErrorBanner, clearErrorBanner } from '../../services/backend';
import { getVisiblePartOptions } from '../../part-options';
import { beatToMs, seekPlayback } from '../../transport/controls';
import { beatFromClick, extractMeasureHitZones } from '../../score/click-seek';
import { type Feature } from '../../feature-types';

function mount(slot: HTMLElement): void {
  // DOM refs — resolved from document because most elements live in the
  // global HTML skeleton, not inside the feature slot.
  const dropZoneEl        = document.getElementById('drop-zone')          as HTMLDivElement;
  const fileInputEl       = document.getElementById('file-input')         as HTMLInputElement;
  const scoreContainerEl  = document.getElementById('score-container')    as HTMLDivElement;
  const scoreInfoEl       = document.getElementById('score-info')         as HTMLDivElement;
  const scoreLoadingEl    = document.getElementById('score-loading')      as HTMLDivElement;
  const partSelectEl      = document.getElementById('part-select')        as HTMLSelectElement;
  const showAccompEl      = document.getElementById('show-accompaniment') as HTMLInputElement;
  const tempoSliderEl     = document.getElementById('tempo-slider')       as HTMLInputElement;
  const transposeSelectEl = document.getElementById('transpose-select')   as HTMLSelectElement;
  const headphoneWarning  = document.getElementById('headphone-warning')  as HTMLDivElement;

  // ── Loading overlay ─────────────────────────────────────────────────────────
  function showLoading(message: string): void {
    scoreLoadingEl.textContent = message;
    scoreLoadingEl.classList.add('visible');
  }
  function hideLoading(): void {
    scoreLoadingEl.classList.remove('visible');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getTransposeSemitones(): number {
    const parsed = parseInt(transposeSelectEl.value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /** Disable/enable all transport controls. Called by score-loader only. */
  function setTransportEnabled(enabled: boolean): void {
    const ids = ['btn-play', 'btn-pause', 'btn-stop', 'btn-rewind',
                 'part-select', 'tempo-slider', 'transpose-select'];
    for (const id of ids) {
      const el = document.getElementById(id) as
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      if (id === 'btn-pause') {
        el.disabled = true;
        continue;
      }
      el.disabled = !enabled;
    }
  }

  // ── Score loading ─────────────────────────────────────────────────────────
  async function loadScore(file: File): Promise<void> {
    clearErrorBanner();
    showLoading(`Loading ${file.name}…`);
    setStatus(`Loading ${file.name}…`, 'loading');
    dropZoneEl.classList.add('hidden');
    scoreInfoEl.textContent = '';
    headphoneWarning.classList.add('hidden');

    // Let other features tear down state from the previous session.
    clearSession();
    scoreContainerEl.innerHTML = '';

    // Kick off soundfont loading early (idempotent) so it overlaps with parse.
    ensureSoundfontLoaded((err) => {
      showErrorBanner('Soundfont failed to load; using synth fallback audio.');
      setStatus('soundfont load failed — synth fallback active', 'error');
      console.error('[Soundfont] load error:', err);
    });

    const renderer = new ScoreRenderer(scoreContainerEl);
    try {
      const model = await renderer.load(file);

      // Populate part selector
      const visibleParts = getVisiblePartOptions(model.parts, showAccompEl.checked);
      partSelectEl.innerHTML = visibleParts
        .map((opt) => `<option value="${opt.name}">${opt.name}</option>`)
        .join('');
      const selectedPart = visibleParts[0]?.name ?? model.parts[0] ?? '';
      partSelectEl.value = selectedPart;
      partSelectEl.disabled = visibleParts.length <= 1;

      const bpm = model.tempo_marks[0]?.bpm ?? 120;
      scoreInfoEl.textContent =
        `${model.title} — ${model.parts.join(', ')} — ${bpm} bpm — ${model.total_beats.toFixed(0)} beats`;

      // Wait for soundfont before constructing engine.
      // getSoundfontLoadPromise() is non-null here because ensureSoundfontLoaded
      // was called above, but TypeScript doesn't know that — hence the ?? fallback.
      await (getSoundfontLoadPromise() ?? Promise.resolve());

      const audioCtx = getAudioContext();
      const sf = getSoundfont();
      const engine = new PlaybackEngine(audioCtx, sf);
      engine.setTransposeSemitones(getTransposeSemitones());
      engine.schedule(
        model.notes,
        model.tempo_marks,
        selectedPart,
        parseFloat(tempoSliderEl.value) / 100,
      );

      renderer.applyVisualTranspose(getTransposeSemitones());
      const cursor = new ScoreCursor(renderer.osmd, model);
      renderer.setHighlightedPart(selectedPart);

      setSession({ model, renderer, cursor, engine, selectedPart });
      setTransportEnabled(true);
      setStatus('score loaded', 'ok');
    } catch (err) {
      showErrorBanner('Could not load this MusicXML file. Try exporting again from notation software.');
      setStatus(String(err), 'error');
      console.error('Score load failed:', err);
      dropZoneEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  }

  // ── Click-to-seek on the score canvas ──────────────────────────────────────
  async function seekToClickedPosition(event: MouseEvent): Promise<void> {
    const session = getSession();
    if (!session) return;
    const { renderer: r, engine, cursor, model } = session;

    const svg = scoreContainerEl.querySelector('svg');
    if (!(svg instanceof SVGSVGElement)) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const svgPoint = svg.createSVGPoint();
    svgPoint.x = event.clientX;
    svgPoint.y = event.clientY;
    const local = svgPoint.matrixTransform(ctm.inverse());

    const zones = extractMeasureHitZones(r.osmd);
    const targetBeat = beatFromClick(zones, local.x, local.y);
    if (targetBeat === null) return;

    try {
      await seekPlayback(beatToMs(targetBeat, model, engine.tempoMultiplier));
    } catch (err) {
      setStatus(`seek failed: ${String(err)}`, 'error');
      console.error('Seek failed:', err);
      return;
    }
    engine.seekToBeat(targetBeat);
    cursor.seekToBeat(targetBeat);
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  setTransportEnabled(false);

  dropZoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZoneEl.classList.add('drag-over');
  });
  dropZoneEl.addEventListener('dragleave', () => {
    dropZoneEl.classList.remove('drag-over');
  });
  dropZoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZoneEl.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file) void loadScore(file);
  });
  dropZoneEl.addEventListener('click', () => fileInputEl.click());

  const btnBrowse = document.getElementById('btn-browse') as HTMLButtonElement;
  btnBrowse.addEventListener('click', () => fileInputEl.click());

  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) void loadScore(file);
  });

  scoreContainerEl.addEventListener('click', (event) => {
    void seekToClickedPosition(event);
  });

  void slot; // slot arg required by Feature interface; unused in this layout
}

function unmount(): void {
  clearSession();
}

export const scoreLoaderFeature: Feature = {
  id: 'slot-score-loader',
  mount,
  unmount,
};
