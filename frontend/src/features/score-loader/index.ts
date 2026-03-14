/**
 * score-loader feature
 *
 * Owns:
 *   - #slot-score-loader (drop zone + file picker)
 *   - #slot-score-info   (score metadata readout)
 *   - #slot-score-main   (score-container + loading spinner)
 *
 * After a score loads successfully it writes a ScoreSession via setSession().
 * Before loading a new score it calls clearSession() so other features clean up.
 *
 * Responsibilities that deliberately live HERE and nowhere else:
 *   - File I/O (drag-drop, browse, change)
 *   - Fetching /health via checkBackend (delegated to services/backend)
 *   - Constructing ScoreRenderer, PlaybackEngine, ScoreCursor
 *   - Click-to-seek on the score canvas
 */
import { ScoreRenderer } from '../../score/renderer';
import { ScoreCursor } from '../../score/cursor';
import { PlaybackEngine } from '../../playback/engine';
import { getAudioContext, getSoundfont, ensureSoundfontLoaded } from '../../services/audio-context';
import { setSession, clearSession } from '../../services/score-session';
import { setStatus, showErrorBanner, clearErrorBanner } from '../../services/backend';
import { getVisiblePartOptions } from '../../part-options';
import { beatToMs, seekPlayback } from '../../transport/controls';
import { beatFromClick, extractMeasureHitZones } from '../../score/click-seek';
import { type Feature } from '../../registry';

function mount(slot: HTMLElement): void {
  // ── DOM refs (resolved from document, not the slot, since most elements
  //    live in fixed positions in index.html's global skeleton) ──────────────
  const dropZoneEl        = document.getElementById('drop-zone')       as HTMLDivElement;
  const fileInputEl       = document.getElementById('file-input')      as HTMLInputElement;
  const scoreContainerEl  = document.getElementById('score-container') as HTMLDivElement;
  const scoreInfoEl       = document.getElementById('score-info')      as HTMLDivElement;
  const scoreLoadingEl    = document.getElementById('score-loading')   as HTMLDivElement;
  const partSelectEl      = document.getElementById('part-select')     as HTMLSelectElement;
  const showAccompEl      = document.getElementById('show-accompaniment') as HTMLInputElement;
  const tempoSliderEl     = document.getElementById('tempo-slider')    as HTMLInputElement;
  const transposeSelectEl = document.getElementById('transpose-select') as HTMLSelectElement;
  const headphoneWarning  = document.getElementById('headphone-warning') as HTMLDivElement;

  let renderer: ScoreRenderer | null = null;

  // ── Loading overlay helpers ───────────────────────────────────────────────
  function showLoading(message: string): void {
    scoreLoadingEl.textContent = message;
    scoreLoadingEl.classList.add('visible');
  }

  function hideLoading(): void {
    scoreLoadingEl.classList.remove('visible');
  }

  // ── Transpose helper ──────────────────────────────────────────────────────
  function getTransposeSemitones(): number {
    const parsed = parseInt(transposeSelectEl.value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // ── Score loading ─────────────────────────────────────────────────────────
  async function loadScore(file: File): Promise<void> {
    clearErrorBanner();
    showLoading(`Loading ${file.name}…`);
    setStatus(`Loading ${file.name}…`, 'loading');
    dropZoneEl.classList.add('hidden');
    scoreInfoEl.textContent = '';
    headphoneWarning.classList.add('hidden');

    // Notify all features to clean up previous session.
    clearSession();

    // Tear down previous renderer if any.
    scoreContainerEl.innerHTML = '';

    // Kick off soundfont loading (idempotent) so it overlaps with score parse.
    ensureSoundfontLoaded((err) => {
      showErrorBanner('Soundfont failed to load; using synth fallback audio.');
      setStatus(`soundfont load failed — synth fallback active`, 'error');
      console.error('[Soundfont] load error:', err);
    });

    renderer = new ScoreRenderer(scoreContainerEl);
    try {
      const model = await renderer.load(file);

      // Populate part selector.
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
      await getSoundfontLoadPromise();

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

  // ── Transport enable helper (kept here to avoid circular dep with playback) ──
  function setTransportEnabled(enabled: boolean): void {
    const ids = ['btn-play', 'btn-pause', 'btn-stop', 'btn-rewind',
                 'part-select', 'tempo-slider', 'transpose-select'];
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
      if (el) el.disabled = !enabled;
    }
  }

  // ── Click-to-seek on score canvas ─────────────────────────────────────────
  async function seekToClickedPosition(event: MouseEvent): Promise<void> {
    const { getSession } = await import('../../services/score-session');
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

  // Initialise transport disabled until score loaded.
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

  // The slot itself is unused as a mount point in this layout (elements are
  // globally positioned in index.html) but the feature signature requires it.
  void slot;
}

function unmount(): void {
  clearSession();
}

export const scoreLoaderFeature: Feature = {
  id: 'slot-score-loader',
  mount,
  unmount,
};
