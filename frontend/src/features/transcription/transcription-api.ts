export interface TranscriptionResponse {
  musicxml: string;
  tempoBpm: number | null;
  keySignature: string | null;
}

export interface ParsedTranscriptionNote {
  pitch: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface ParsedTranscriptionSegment {
  startSeconds: number;
  endSeconds: number;
  noteCount: number;
}

export interface ParsedTranscriptionSummary {
  notes: ParsedTranscriptionNote[];
  segments: ParsedTranscriptionSegment[];
  tempoBpm: number | null;
  keySignature: string | null;
}

interface PendingTranscriptionResponse {
  id?: string;
  result_url?: string;
  status?: string;
  musicxml?: string;
  tempo_bpm?: number | null;
  key_signature?: string | null;
}

const DEFAULT_TRANSCRIPTION_ENDPOINT = '/transcribe/audio';
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 30;
const DIVISIONS_FALLBACK = 1;

function extensionFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

function inferContentType(filename: string): string {
  const extension = extensionFromFilename(filename);
  if (extension === '.mp3') return 'audio/mpeg';
  return 'audio/wav';
}

async function extractError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const payload = await response.json() as { detail?: string };
    return payload.detail ?? `HTTP ${response.status}`;
  }
  return (await response.text()) || `HTTP ${response.status}`;
}

function parseSyncResponse(musicxml: string, headers: Headers): TranscriptionResponse {
  const tempoHeader = headers.get('x-transcription-tempo-bpm');
  const keyHeader = headers.get('x-transcription-key-signature');
  return {
    musicxml,
    tempoBpm: tempoHeader ? Number(tempoHeader) : null,
    keySignature: keyHeader,
  };
}

async function pollForResult(resultUrl: string): Promise<TranscriptionResponse> {
  for (let attempt = 0; attempt < DEFAULT_MAX_POLLS; attempt += 1) {
    const response = await fetch(resultUrl);
    if (!response.ok) {
      throw new Error(await extractError(response));
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/vnd.recordare.musicxml+xml') || contentType.includes('application/xml') || contentType.includes('text/xml')) {
      return parseSyncResponse(await response.text(), response.headers);
    }

    const payload = await response.json() as PendingTranscriptionResponse;
    if (payload.musicxml) {
      return {
        musicxml: payload.musicxml,
        tempoBpm: payload.tempo_bpm ?? null,
        keySignature: payload.key_signature ?? null,
      };
    }

    if (payload.status && payload.status !== 'pending') {
      throw new Error(`Transcription did not complete successfully (status: ${payload.status}).`);
    }

    await new Promise((resolve) => {
      window.setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS);
    });
  }

  throw new Error('Transcription timed out. Please try again.');
}

export async function requestTranscription(file: File): Promise<TranscriptionResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  const response = await fetch(DEFAULT_TRANSCRIPTION_ENDPOINT, {
    method: 'POST',
    body: formData,
    headers: {
      Accept: 'application/json, application/vnd.recordare.musicxml+xml, text/xml',
      'x-upload-content-type': file.type || inferContentType(file.name),
    },
  });

  if (!response.ok) {
    throw new Error(await extractError(response));
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/vnd.recordare.musicxml+xml') || contentType.includes('application/xml') || contentType.includes('text/xml')) {
    return parseSyncResponse(await response.text(), response.headers);
  }

  const payload = await response.json() as PendingTranscriptionResponse;
  if (payload.musicxml) {
    return {
      musicxml: payload.musicxml,
      tempoBpm: payload.tempo_bpm ?? null,
      keySignature: payload.key_signature ?? null,
    };
  }

  const resultUrl = payload.result_url ?? (payload.id ? `/result/${payload.id}` : null);
  if (!resultUrl) {
    throw new Error('Backend returned an unsupported transcription response.');
  }
  return pollForResult(resultUrl);
}

function pitchNameFromNote(noteEl: Element): string {
  const step = noteEl.querySelector('pitch > step')?.textContent?.trim() ?? '';
  const alter = Number(noteEl.querySelector('pitch > alter')?.textContent ?? '0');
  const octave = noteEl.querySelector('pitch > octave')?.textContent?.trim() ?? '';
  const accidental = alter === 1 ? '#' : alter === -1 ? 'b' : '';
  return `${step}${accidental}${octave}`;
}

function readTempoBpm(xml: Document): number | null {
  const soundTempo = xml.querySelector('sound[tempo]')?.getAttribute('tempo');
  if (soundTempo) {
    const parsed = Number(soundTempo);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const perMinute = xml.querySelector('direction-type metronome per-minute')?.textContent;
  if (perMinute) {
    const parsed = Number(perMinute);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readKeySignature(xml: Document): string | null {
  const fifthsText = xml.querySelector('attributes key fifths')?.textContent;
  if (fifthsText === null || fifthsText === undefined) return null;
  const fifths = Number(fifthsText);
  if (!Number.isFinite(fifths)) return null;
  const map: Record<number, string> = {
    '-7': 'Cb major',
    '-6': 'Gb major',
    '-5': 'Db major',
    '-4': 'Ab major',
    '-3': 'Eb major',
    '-2': 'Bb major',
    '-1': 'F major',
    '0': 'C major',
    '1': 'G major',
    '2': 'D major',
    '3': 'A major',
    '4': 'E major',
    '5': 'B major',
    '6': 'F# major',
    '7': 'C# major',
  };
  return map[fifths] ?? null;
}

export function parseMusicXmlSummary(
  musicxml: string,
  fallbackTempoBpm: number | null = null,
  fallbackKeySignature: string | null = null,
): ParsedTranscriptionSummary {
  const xml = new DOMParser().parseFromString(musicxml, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) {
    throw new Error('Backend returned invalid MusicXML.');
  }

  const notes: ParsedTranscriptionNote[] = [];
  const segments: ParsedTranscriptionSegment[] = [];
  let currentSegment: ParsedTranscriptionSegment | null = null;
  let currentSeconds = 0;

  for (const measureEl of Array.from(xml.querySelectorAll('part > measure'))) {
    const measureDivisions = Number(measureEl.querySelector('attributes > divisions')?.textContent ?? `${DIVISIONS_FALLBACK}`);
    const divisions = Number.isFinite(measureDivisions) && measureDivisions > 0 ? measureDivisions : DIVISIONS_FALLBACK;

    for (const noteEl of Array.from(measureEl.querySelectorAll(':scope > note'))) {
      const durationDivisions = Number(noteEl.querySelector('duration')?.textContent ?? '0');
      const durationSeconds = durationDivisions / divisions;
      const isRest = noteEl.querySelector('rest') !== null;
      const isChordTone = noteEl.querySelector('chord') !== null;
      const startSeconds = isChordTone && notes.length > 0 ? notes[notes.length - 1].startSeconds : currentSeconds;

      if (!isRest) {
        const note = {
          pitch: pitchNameFromNote(noteEl),
          startSeconds,
          durationSeconds,
        };
        notes.push(note);
        if (!currentSegment) {
          currentSegment = {
            startSeconds,
            endSeconds: startSeconds + durationSeconds,
            noteCount: 1,
          };
        } else {
          currentSegment.endSeconds = Math.max(currentSegment.endSeconds, startSeconds + durationSeconds);
          currentSegment.noteCount += 1;
        }
      } else if (currentSegment) {
        segments.push(currentSegment);
        currentSegment = null;
      }

      if (!isChordTone) {
        currentSeconds += durationSeconds;
      }
    }
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return {
    notes,
    segments,
    tempoBpm: fallbackTempoBpm ?? readTempoBpm(xml),
    keySignature: fallbackKeySignature ?? readKeySignature(xml),
  };
}
