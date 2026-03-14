import { subscribePracticeHistory, exportPracticeHistory, type PracticeSessionSummary } from '../../services/progress-history';
import { midiToNoteName } from '../../pitch/note-name';
import { type Feature } from '../../feature-types';

let unsubscribeHistory: (() => void) | null = null;

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function renderRange(session: PracticeSessionSummary): string {
  if (session.minMidi === null || session.maxMidi === null) return '—';
  return `${midiToNoteName(session.minMidi)} → ${midiToNoteName(session.maxMidi)}`;
}

function buildCsv(sessions: PracticeSessionSummary[]): string {
  const header = ['date_time', 'piece_name', 'part', 'session_range', 'average_pitch_confidence', 'duration_singing_ms'];
  const rows = sessions.map((s) => [
    s.timestamp,
    s.pieceName,
    s.part,
    renderRange(s),
    s.averageConfidence.toFixed(3),
    String(Math.round(s.singingDurationMs)),
  ]);
  const escapeCsvValue = (value: string): string => `"${value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', ' ')
    .replaceAll('"', '""')}"`;

  return [header, ...rows]
    .map((r) => r.map((value) => escapeCsvValue(value)).join(','))
    .join('\n');
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = `
    <section id="progress-history-panel" aria-label="Practice progress history">
      <div id="progress-history-header">
        <strong>Practice history</strong>
        <div class="progress-actions">
          <button id="btn-progress-export-json" class="transport-btn">Export JSON</button>
          <button id="btn-progress-export-csv" class="transport-btn">Export CSV</button>
        </div>
      </div>
      <div id="progress-summary"></div>
      <div id="progress-range-chart" aria-label="Range history chart"></div>
      <div id="progress-history-list" aria-live="polite"></div>
    </section>
  `;

  const listEl = document.getElementById('progress-history-list') as HTMLDivElement;
  const summaryEl = document.getElementById('progress-summary') as HTMLDivElement;
  const rangeChartEl = document.getElementById('progress-range-chart') as HTMLDivElement;
  const exportJsonBtn = document.getElementById('btn-progress-export-json') as HTMLButtonElement;
  const exportCsvBtn = document.getElementById('btn-progress-export-csv') as HTMLButtonElement;

  let latestSessions: PracticeSessionSummary[] = [];

  const render = (sessions: PracticeSessionSummary[]): void => {
    latestSessions = sessions;
    if (sessions.length === 0) {
      summaryEl.textContent = 'No saved sessions yet. Start singing to build your history.';
      rangeChartEl.innerHTML = '';
      listEl.innerHTML = '<div class="progress-empty">No sessions saved.</div>';
      return;
    }

    const totalMs = sessions.reduce((sum, s) => sum + s.singingDurationMs, 0);
    summaryEl.textContent = `${sessions.length} sessions • ${formatDuration(totalMs)} total singing time`;

    const withRange = sessions.filter((s) => s.minMidi !== null && s.maxMidi !== null);
    if (withRange.length > 0) {
      const minMidi = Math.min(...withRange.map((s) => s.minMidi as number));
      const maxMidi = Math.max(...withRange.map((s) => s.maxMidi as number));
      const span = Math.max(1, maxMidi - minMidi);
      rangeChartEl.innerHTML = withRange.slice(0, 20).map((s) => {
        const start = (((s.minMidi as number) - minMidi) / span) * 100;
        const width = (((s.maxMidi as number) - (s.minMidi as number)) / span) * 100;
        return `<div class="range-row"><span>${new Date(s.timestamp).toLocaleDateString()}</span><div class="range-track"><div class="range-bar" style="left:${start}%;width:${Math.max(width, 1)}%"></div></div></div>`;
      }).join('');
    } else {
      rangeChartEl.innerHTML = '<div class="progress-empty">Range chart unavailable (no voiced frames).</div>';
    }

    listEl.innerHTML = sessions.slice(0, 20).map((s) => `
      <article class="progress-item">
        <div><strong>${new Date(s.timestamp).toLocaleString()}</strong></div>
        <div>${s.pieceName} • ${s.part}</div>
        <div>Range: ${renderRange(s)}</div>
        <div>Confidence: ${s.averageConfidence.toFixed(2)} • Singing: ${formatDuration(s.singingDurationMs)}</div>
      </article>
    `).join('');
  };

  unsubscribeHistory?.();
  unsubscribeHistory = subscribePracticeHistory(render);

  function triggerDownload(filename: string, mime: string, content: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportJsonBtn.addEventListener('click', () => {
    triggerDownload('sing-attune-history.json', 'application/json', exportPracticeHistory());
  });
  exportCsvBtn.addEventListener('click', () => {
    triggerDownload('sing-attune-history.csv', 'text/csv;charset=utf-8', buildCsv(latestSessions));
  });

}

function unmount(): void {
  unsubscribeHistory?.();
  unsubscribeHistory = null;
}

export const progressHistoryFeature: Feature = {
  id: 'slot-progress-history',
  mount,
  unmount,
};
