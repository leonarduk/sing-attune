import { type Feature } from '../../feature-types';
import { clearErrorBanner, showErrorBanner } from '../../services/backend';
import { setAppStatus } from '../../services/status';
import {
  parseMusicXmlSummary,
  requestTranscription,
  type ParsedTranscriptionSummary,
} from './transcription-api';

const ACCEPTED_EXTENSIONS = ['.wav', '.wave', '.mp3'];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

let retryLatest: (() => void) | null = null;
let currentObjectUrl: string | null = null;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validateAudioFile(file: File): string | null {
  const lowerName = file.name.toLowerCase();
  const hasSupportedExtension = ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
  if (!hasSupportedExtension) {
    return `Unsupported file type. Choose ${ACCEPTED_EXTENSIONS.join(', ')}.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is too large. Choose an audio file under ${formatBytes(MAX_FILE_SIZE_BYTES)}.`;
  }
  return null;
}

function updateDownloadLink(linkEl: HTMLAnchorElement, musicxml: string): void {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = URL.createObjectURL(
    new Blob([musicxml], { type: 'application/vnd.recordare.musicxml+xml' }),
  );
  linkEl.href = currentObjectUrl;
  linkEl.download = 'transcription.musicxml';
  linkEl.removeAttribute('aria-disabled');
  linkEl.classList.remove('disabled');
}

function renderResult(summaryEl: HTMLDivElement, detailsEl: HTMLDivElement, result: ParsedTranscriptionSummary): void {
  const keyText = result.keySignature ?? 'Unknown';
  summaryEl.innerHTML = `
    <div><strong>Notes:</strong> ${result.notes.length}</div>
    <div><strong>Segments:</strong> ${result.segments.length}</div>
    <div><strong>Tempo:</strong> ${result.tempoBpm ?? 'Unknown'}</div>
    <div><strong>Key:</strong> ${escapeHtml(keyText)}</div>
  `;

  const notesMarkup = result.notes.length > 0
    ? `<table class="transcription-table"><thead><tr><th>Pitch</th><th>Start</th><th>Duration</th></tr></thead><tbody>${result.notes.map((note) => `
      <tr>
        <td>${escapeHtml(note.pitch)}</td>
        <td>${formatSeconds(note.startSeconds)}</td>
        <td>${formatSeconds(note.durationSeconds)}</td>
      </tr>
    `).join('')}</tbody></table>`
    : '<p class="transcription-empty">No notes found in the MusicXML response.</p>';

  const segmentsMarkup = result.segments.length > 0
    ? `<ul class="transcription-segments">${result.segments.map((segment, index) => `
      <li>Segment ${index + 1}: ${formatSeconds(segment.startSeconds)} → ${formatSeconds(segment.endSeconds)} (${segment.noteCount} notes)</li>
    `).join('')}</ul>`
    : '<p class="transcription-empty">No segmentation boundaries detected.</p>';

  detailsEl.innerHTML = `
    <div class="transcription-detail-block">
      <h4>Detected notes</h4>
      ${notesMarkup}
    </div>
    <div class="transcription-detail-block">
      <h4>Segmentation boundaries</h4>
      ${segmentsMarkup}
    </div>
  `;
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = `
    <section id="transcription-panel" aria-label="Audio transcription panel">
      <div class="transcription-header">
        <strong>Audio transcription</strong>
        <span id="transcription-status">Idle</span>
      </div>
      <input id="transcription-file-input" type="file" accept=".wav,.wave,.mp3,audio/wav,audio/mpeg" />
      <div id="transcription-file-meta" class="transcription-meta">No audio selected.</div>
      <div class="transcription-actions">
        <button id="btn-transcription-run" class="transport-btn" disabled>Transcribe</button>
        <button id="btn-transcription-retry" class="transport-btn" disabled>Retry</button>
      </div>
      <div id="transcription-inline-error" class="transcription-error" aria-live="polite"></div>
      <div id="transcription-result" class="transcription-result hidden">
        <div id="transcription-summary" class="transcription-summary"></div>
        <div id="transcription-details"></div>
        <a id="transcription-download" class="transport-btn disabled" aria-disabled="true">Download MusicXML</a>
      </div>
    </section>
  `;

  const inputEl = document.getElementById('transcription-file-input') as HTMLInputElement;
  const fileMetaEl = document.getElementById('transcription-file-meta') as HTMLDivElement;
  const statusEl = document.getElementById('transcription-status') as HTMLSpanElement;
  const runBtn = document.getElementById('btn-transcription-run') as HTMLButtonElement;
  const retryBtn = document.getElementById('btn-transcription-retry') as HTMLButtonElement;
  const errorEl = document.getElementById('transcription-inline-error') as HTMLDivElement;
  const resultEl = document.getElementById('transcription-result') as HTMLDivElement;
  const summaryEl = document.getElementById('transcription-summary') as HTMLDivElement;
  const detailsEl = document.getElementById('transcription-details') as HTMLDivElement;
  const downloadEl = document.getElementById('transcription-download') as HTMLAnchorElement;

  let selectedFile: File | null = null;

  const resetDownload = (): void => {
    downloadEl.removeAttribute('href');
    downloadEl.classList.add('disabled');
    downloadEl.setAttribute('aria-disabled', 'true');
  };

  const setBusy = (busy: boolean, message: string): void => {
    statusEl.textContent = message;
    inputEl.disabled = busy;
    runBtn.disabled = busy || !selectedFile;
    retryBtn.disabled = busy || retryLatest === null;
  };

  const setInlineError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.classList.toggle('visible', message.length > 0);
  };

  const syncSelectedFileUi = (): void => {
    if (!selectedFile) {
      fileMetaEl.textContent = 'No audio selected.';
      runBtn.disabled = true;
      return;
    }
    fileMetaEl.textContent = `${selectedFile.name} • ${formatBytes(selectedFile.size)}`;
    runBtn.disabled = false;
  };

  const runTranscription = async (): Promise<void> => {
    if (!selectedFile) return;

    const validationError = validateAudioFile(selectedFile);
    if (validationError) {
      setInlineError(validationError);
      showErrorBanner(validationError, { dismissible: true });
      resultEl.classList.add('hidden');
      setAppStatus('transcription validation failed', 'error');
      return;
    }

    retryLatest = () => {
      void runTranscription();
    };
    clearErrorBanner();
    setInlineError('');
    resetDownload();
    setBusy(true, 'Transcribing…');
    setAppStatus(`Transcribing ${selectedFile.name}…`, 'warning');

    try {
      const response = await requestTranscription(selectedFile);
      const parsed = parseMusicXmlSummary(response.musicxml, response.tempoBpm, response.keySignature);
      renderResult(summaryEl, detailsEl, parsed);
      updateDownloadLink(downloadEl, response.musicxml);
      resultEl.classList.remove('hidden');
      setBusy(false, 'Complete');
      setAppStatus('transcription ready', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInlineError(message);
      showErrorBanner(message, {
        dismissible: true,
        actionLabel: 'Retry transcription',
        onAction: () => {
          retryLatest?.();
        },
      });
      setBusy(false, 'Failed');
      setAppStatus('transcription failed', 'error');
      resultEl.classList.add('hidden');
    }
  };

  inputEl.addEventListener('change', () => {
    const [file] = Array.from(inputEl.files ?? []);
    selectedFile = file ?? null;
    setInlineError('');
    resetDownload();
    resultEl.classList.add('hidden');
    syncSelectedFileUi();
  });

  runBtn.addEventListener('click', () => {
    void runTranscription();
  });
  retryBtn.addEventListener('click', () => {
    retryLatest?.();
  });
  downloadEl.addEventListener('click', (event) => {
    if (!downloadEl.href) {
      event.preventDefault();
    }
  });

  syncSelectedFileUi();
  resetDownload();
}

export const transcriptionFeature: Feature = {
  id: 'slot-transcription',
  mount,
};
