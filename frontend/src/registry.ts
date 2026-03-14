/**
 * Feature registry.
 *
 * This is the ONLY file that changes when a new feature is added.
 * Import the feature, add one line to the array — nothing else.
 *
 * main.ts never changes.
 */
import { scoreLoaderFeature  } from './features/score-loader/index';
import { playbackFeature     } from './features/playback/index';
import { partSelectorFeature } from './features/part-selector/index';
import { pitchOverlayFeature } from './features/pitch-overlay/index';

export interface Feature {
  /** Must match the id of the corresponding DOM slot in index.html. */
  id: string;
  mount(slot: HTMLElement): void;
  unmount?(): void;
}

export const features: Feature[] = [
  scoreLoaderFeature,
  playbackFeature,
  partSelectorFeature,
  pitchOverlayFeature,
];
