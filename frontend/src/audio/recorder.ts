export type RecordingState = 'idle' | 'recording' | 'recorded';

export type RecordingAction =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'discard' };

export function nextRecordingState(state: RecordingState, action: RecordingAction): RecordingState {
  if (action.type === 'start') return 'recording';
  if (action.type === 'stop') return state === 'recording' ? 'recorded' : state;
  return 'idle';
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function getSupportedRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }

  return PREFERRED_MIME_TYPES.find((mime) => MediaRecorder.isTypeSupported(mime));
}

export class PracticeRecorder {
  state: RecordingState = 'idle';
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private takeUrl: string | null = null;
  private takeBlob: Blob | null = null;
  private takeMimeType: string | null = null;
  private stopPromise: Promise<void> | null = null;

  static isSupported(): boolean {
    return typeof window !== 'undefined'
      && typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined';
  }

  async start(): Promise<void> {
    if (!PracticeRecorder.isSupported()) throw new Error('Recording is not supported in this browser.');
    if (this.state === 'recording') return;

    this.discard();
    this.chunks = [];

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;

    try {
      const mimeType = getSupportedRecordingMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };

      recorder.start();
      this.mediaRecorder = recorder;
      this.state = nextRecordingState(this.state, { type: 'start' });
    } catch (error) {
      this.cleanupStream();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.mediaRecorder || this.state !== 'recording') return;

    const recorder = this.mediaRecorder;
    this.stopPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const takeBlob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.takeBlob = takeBlob;
        this.takeMimeType = takeBlob.type;
        this.takeUrl = URL.createObjectURL(takeBlob);
        this.cleanupStream();
        this.mediaRecorder = null;
        this.chunks = [];
        this.state = nextRecordingState(this.state, { type: 'stop' });
        this.stopPromise = null;
        resolve();
      };

      recorder.onstop = finish;
      recorder.stop();

      if (recorder.state === 'inactive') {
        finish();
      }
    });

    return this.stopPromise;
  }

  async saveLastTake(): Promise<boolean> {
    if (!this.takeBlob || this.state !== 'recorded') return false;

    const extension = this.fileExtensionForMimeType(this.takeMimeType);
    const filename = `practice-take.${extension}`;

    const savePicker = (window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<{
        createWritable: () => Promise<{ write: (blob: Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }).showSaveFilePicker;

    if (typeof savePicker === 'function') {
      const handle = await savePicker({
        suggestedName: filename,
        types: [{
          description: 'Audio recording',
          accept: {
            [this.takeMimeType || 'audio/webm']: [`.${extension}`],
          },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(this.takeBlob);
      await writable.close();
      return true;
    }

    if (!this.takeUrl) return false;
    const link = document.createElement('a');
    link.href = this.takeUrl;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  playLastTake(): HTMLAudioElement | null {
    if (!this.takeUrl || this.state !== 'recorded') return null;
    const audio = new Audio(this.takeUrl);
    void audio.play().catch(() => undefined);
    return audio;
  }

  discard(): void {
    if (this.takeUrl) {
      URL.revokeObjectURL(this.takeUrl);
      this.takeUrl = null;
    }
    this.takeBlob = null;
    this.takeMimeType = null;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    this.stopPromise = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.cleanupStream();
    this.state = nextRecordingState(this.state, { type: 'discard' });
  }

  destroy(): void {
    this.discard();
  }

  private cleanupStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private fileExtensionForMimeType(mimeType: string | null): string {
    if (!mimeType) return 'webm';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('wav')) return 'wav';
    return 'webm';
  }
}
