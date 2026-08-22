import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPlaybackVoiceId,
  persistPlaybackVoiceId,
} from './audio-preflight';
import { DEFAULT_PLAYBACK_INSTRUMENT_ID } from '../playback/soundfont';

const PLAYBACK_VOICE_KEY = 'sing-attune.preflight.playbackVoice';

describe('playback voice setting persistence (#361)', () => {
  afterEach(() => {
    localStorage.removeItem(PLAYBACK_VOICE_KEY);
  });

  it('defaults to a vocal timbre when nothing has been persisted', () => {
    expect(loadPlaybackVoiceId()).toBe(DEFAULT_PLAYBACK_INSTRUMENT_ID);
    expect(DEFAULT_PLAYBACK_INSTRUMENT_ID).not.toBe('acoustic_grand_piano');
  });

  it('persists and reloads a selected playback voice across "reloads"', () => {
    persistPlaybackVoiceId('voice_oohs');
    expect(localStorage.getItem(PLAYBACK_VOICE_KEY)).toBe('voice_oohs');
    // Simulate a fresh page load reading back the persisted value.
    expect(loadPlaybackVoiceId()).toBe('voice_oohs');
  });

  it('persists the piano choice too, since it remains a valid option', () => {
    persistPlaybackVoiceId('acoustic_grand_piano');
    expect(loadPlaybackVoiceId()).toBe('acoustic_grand_piano');
  });

  it('falls back to the default when localStorage holds an unrecognized value', () => {
    localStorage.setItem(PLAYBACK_VOICE_KEY, 'not-a-real-instrument');
    expect(loadPlaybackVoiceId()).toBe(DEFAULT_PLAYBACK_INSTRUMENT_ID);
  });
});
