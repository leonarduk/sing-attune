/**
 * Feature registry.
 *
 * This is the ONLY file that changes when a new feature is added.
 * Import the feature, add one line to the array — nothing else.
 *
 * main.ts never changes.
 */
import { type Feature } from './feature-types';

import { scoreLoaderFeature  } from './features/score-loader/index';
import { playbackFeature     } from './features/playback/index';
import { partSelectorFeature } from './features/part-selector/index';
import { pitchOverlayFeature } from './features/pitch-overlay/index';
import { audioPreflightFeature } from './features/audio-preflight/index';

export type { Feature } from './feature-types';

export const features: Feature[] = [
  scoreLoaderFeature,
  playbackFeature,
  partSelectorFeature,
  pitchOverlayFeature,
  audioPreflightFeature,
];
