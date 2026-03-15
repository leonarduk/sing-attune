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
import { ScoreRenderer, type ScoreModel } from '../../score/renderer';
import { ScoreCursor } from '../../score/cursor';
import { PlaybackEngine } from '../../playback/engine';
import './score-loader.css';
import {
  getAudioContext,
  getSoundfont,
  ensureSoundfontLoaded,
  getSoundfontLoadPromise,
  getPlaybackTimbreMode,
} from '../../services/audio-context';
import { setSession, clearSession, getSession } from '../../services/score-session';
import { showErrorBanner, clearErrorBanner } from '../../services/backend';
import { setAppStatus } from '../../services/status';
import { showToast } from '../../services/toast';
import { getVisiblePartOptions } from '../../part-options';
import { beatToMs, seekPlayback, postPlayback } from '../../transport/controls';
import { beatFromClick, extractMeasureHitZones, measureBoundaryFromPoint } from '../../score/click-seek';
import { clearLoopRegion, getLoopRegion, onLoopRegionChanged, setLoopEnd, setLoopStart } from '../../services/loop-region';
import { type Feature } from '../../feature-types';

let removeLoopRegionListener: (() => void) | null = null;

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
  const btnLoadTestScore  = document.getElementById('btn-load-test-score') as HTMLButtonElement | null;

  function renderLoopOverlay(): void {
    const session = getSession();
    if (!session) return;
    const svg = scoreContainerEl.querySelector('svg');
    if (!(svg instanceof SVGSVGElement)) return;

    svg.querySelectorAll('g[data-loop-overlay="true"]').forEach((node) => node.remove());

    const region = getLoopRegion();
    if (!region.active) return;

    const zones = extractMeasureHitZones(session.renderer.osmd);
    if (zones.length === 0) return;

    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-loop-overlay', 'true');

    for (const zone of zones) {
      const zoneStart = zone.beatStart;
      const zoneEnd = zone.beatStart + zone.beatDuration;
      const startBeat = Math.max(zoneStart, region.startBeat);
      const endBeat = Math.min(zoneEnd, region.endBeat);
      if (endBeat <= startBeat) continue;

      const startRatio = (startBeat - zoneStart) / zone.beatDuration;
      const endRatio = (endBeat - zoneStart) / zone.beatDuration;
      const x = zone.x + (zone.width * startRatio);
      const width = Math.max(1, zone.width * (endRatio - startRatio));

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x.toFixed(3));
      rect.setAttribute('y', zone.y.toFixed(3));
      rect.setAttribute('width', width.toFixed(3));
      rect.setAttribute('height', zone.height.toFixed(3));
      rect.setAttribute('fill', 'rgba(233, 69, 96, 0.22)');
      rect.setAttribute('stroke', '#e94560');
      rect.setAttribute('stroke-width', '1');
      rect.setAttribute('pointer-events', 'none');
      layer.appendChild(rect);
    }

    if (layer.childNodes.length > 0) {
      svg.appendChild(layer);
    }
  }

  // ── Loading overlay ─────────────────────────────────────────────────────────
  const dropZoneIdleMarkup = dropZoneEl.innerHTML;

  function showLoading(message: string): void {
    scoreLoadingEl.textContent = message;
    scoreLoadingEl.classList.add('visible');
  }
  function hideLoading(): void {
    scoreLoadingEl.classList.remove('visible');
  }

  function resetDropZoneToIdle(): void {
    dropZoneEl.innerHTML = dropZoneIdleMarkup;
    dropZoneEl.classList.remove('hidden', 'drag-over');
    scoreLoadingEl.textContent = 'No score loaded.';
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

  async function teardownPreviousSession(): Promise<void> {
    const previousSession = getSession();
    if (!previousSession) return;

    // Capture state before stopping — engine.stop() transitions to 'idle'.
    const wasActive = previousSession.engine.state !== 'idle';

    // Stop frontend audio unconditionally — this is the critical operation.
    // engine.stop() calls _stopSources() which wraps each src.stop() in
    // try/catch, so it cannot throw.
    previousSession.engine.stop();
    previousSession.cursor.stop();
    previousSession.cursor.osmd.cursor.show();

    // Best-effort backend notification so the pipeline resets its state.
    // Failure is non-fatal — audio is already silent.
    if (wasActive) {
      try {
        await postPlayback('/playback/stop');
      } catch (err) {
        console.warn('Score swap: backend stop notification failed (non-fatal):', err);
      }
    }
  }

  async function loadDevTestScore(filename: string): Promise<void> {
    try {
      setAppStatus(`Loading test score ${filename}…`, 'warning');
      const response = await fetch(`/musescore/${filename}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'application/vnd.recordare.musicxml+xml' });
      await loadScore(file);
    } catch (err) {
      showErrorBanner(`Could not load test score ${filename}.`);
      setAppStatus(`test score load failed: ${String(err)}`, 'error');
      console.error('Dev test score load failed:', err);
    }
  }

  async function loadScore(file: File): Promise<void> {
    clearErrorBanner();
    showLoading(`Loading ${file.name}…`);
    setAppStatus(`Loading ${file.name}…`, 'warning');
    dropZoneEl.classList.add('hidden');
    scoreInfoEl.textContent = '';
    headphoneWarning.classList.add('hidden');
    setTransportEnabled(false);

    await teardownPreviousSession();

    // Let other features tear down state from the previous session.
    clearSession();
    clearLoopRegion();
    scoreContainerEl.innerHTML = '';

    // Kick off soundfont loading early (idempotent) so it overlaps with parse.
    ensureSoundfontLoaded((err) => {
      showErrorBanner('Soundfont failed to load; using synth fallback audio.', { dismissible: true });
      setAppStatus('soundfont unavailable — using synthesised tones', 'error');
      showToast('Soundfont unavailable — using synthesised tones', {
        variant: 'warning',
        dedupeKey: 'soundfont-fallback',
      });
      console.error('[Soundfont] load error:', err);
    });

    const renderer = new ScoreRenderer(scoreContainerEl);
    let model: ScoreModel;

    try {
      model = await renderer.load(file);
    } catch (err) {
      showErrorBanner('Could not load this MusicXML file. Try exporting again from notation software.');
      setAppStatus(String(err), 'error');
      console.error('Score parse/render failed:', err);
      resetDropZoneToIdle();
      hideLoading();
      return;
    }

    try {
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
      renderLoopOverlay();
      setTransportEnabled(true);
      if (getPlaybackTimbreMode() === 'synth-fallback') {
        setAppStatus('score loaded — synth fallback active', 'error');
      } else {
        setAppStatus('score loaded', 'success');
      }
    } catch (err) {
      showErrorBanner('Score loaded, but playback setup failed. Check audio/soundfont settings and try again.');
      setAppStatus(String(err), 'error');
      console.error('Post-parse score setup failed:', err);
      resetDropZoneToIdle();
    } finally {
      hideLoading();
    }
  }

  // ── Click-to-seek and loop selection on score canvas ──────────────────────
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
    if (event.shiftKey) {
      const boundary = measureBoundaryFromPoint(zones, local.x, local.y);
      if (!boundary) return;
      setLoopEnd(boundary.endBeat);
      renderLoopOverlay();
      setAppStatus(`Loop end set to beat ${boundary.endBeat.toFixed(2)}`, 'success');
      return;
    }

    const boundary = measureBoundaryFromPoint(zones, local.x, local.y);
    if (boundary) {
      setLoopStart(boundary.startBeat);
      renderLoopOverlay();
      setAppStatus(`Loop start set to beat ${boundary.startBeat.toFixed(2)}`, 'success');
    }

    const targetBeat = beatFromClick(zones, local.x, local.y);
    if (targetBeat === null) return;

    try {
      await seekPlayback(beatToMs(targetBeat, model, engine.tempoMultiplier));
    } catch (err) {
      setAppStatus(`seek failed: ${String(err)}`, 'error');
      console.error('Seek failed:', err);
      return;
    }
    engine.seekToBeat(targetBeat);
    cursor.seekToBeat(targetBeat);
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  setTransportEnabled(false);
  removeLoopRegionListener?.();
  removeLoopRegionListener = onLoopRegionChanged(() => {
    renderLoopOverlay();
  });

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

  if (btnLoadTestScore) {
    const devScoreFilename = 'homeward_bound.mxl';
    void fetch(`/musescore/${devScoreFilename}`, { method: 'HEAD' })
      .then((response) => {
        if (!response.ok) return;
        btnLoadTestScore.style.display = '';
        btnLoadTestScore.addEventListener('click', () => {
          void loadDevTestScore(devScoreFilename);
        });
      })
      .catch(() => {
        // Test score endpoint unavailable (e.g. production build).
      });
  }

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
  removeLoopRegionListener?.();
  removeLoopRegionListener = null;
}

export const scoreLoaderFeature: Feature = {
  id: 'slot-score-loader',
  mount,
  unmount,
};
