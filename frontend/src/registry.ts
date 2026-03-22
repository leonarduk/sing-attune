/**
 * Feature registry.
 *
 * This is the ONLY file that changes when a new feature is added.
 * Import the feature, add one line to the array — nothing else.
 *
 * main.ts never changes.
 */
import { type Feature } from './feature-types';

import { onboardingFeature } from './features/onboarding/index';
import { scoreLoaderFeature  } from './features/score-loader/index';
import { playbackFeature     } from './features/playback/index';
import { partSelectorFeature } from './features/part-selector/index';
import { partMixerFeature } from './features/part-mixer/index';
import { pitchOverlayFeature } from './features/pitch-overlay/index';
import { audioPreflightFeature } from './features/audio-preflight/index';
import { progressHistoryFeature } from './features/progress-history/index';
import { transcriptionFeature } from './features/transcription/index';

export type { Feature } from './feature-types';

export const features: Feature[] = [
  onboardingFeature,
  scoreLoaderFeature,
  playbackFeature,
  partSelectorFeature,
  partMixerFeature,
  pitchOverlayFeature,
  audioPreflightFeature,
  progressHistoryFeature,
  transcriptionFeature,
];
