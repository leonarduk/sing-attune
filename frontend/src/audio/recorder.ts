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
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getSupportedRecordingMimeType();
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.mediaRecorder.start();
    this.state = nextRecordingState(this.state, { type: 'start' });
  }

  async stop(): Promise<void> {
    if (!this.mediaRecorder || this.state !== 'recording') return;

    const recorder = this.mediaRecorder;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const takeBlob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.takeUrl = URL.createObjectURL(takeBlob);
        this.cleanupStream();
        resolve();
      };
      recorder.stop();
    });

    this.mediaRecorder = null;
    this.chunks = [];
    this.state = nextRecordingState(this.state, { type: 'stop' });
  }

  playLastTake(): HTMLAudioElement | null {
    if (!this.takeUrl || this.state !== 'recorded') return null;
    const audio = new Audio(this.takeUrl);
    void audio.play();
    return audio;
  }

  discard(): void {
    if (this.takeUrl) {
      URL.revokeObjectURL(this.takeUrl);
      this.takeUrl = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

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
}
