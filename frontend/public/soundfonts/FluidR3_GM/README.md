# FluidR3_GM soundfont assets — provenance, licence, and how to add a voice

This directory bundles pre-generated General MIDI instrument samples so
playback works **offline** (see the "Offline note" in
`frontend/src/playback/soundfont.ts`). This README records where they came
from and how to add/refresh one. See issue #403.

## What's bundled

| File | Instrument id | Status |
|---|---|---|
| `acoustic_grand_piano-mp3.js` | `acoustic_grand_piano` | Bundled locally |
| `choir_aahs-mp3.js` | `choir_aahs` | Bundled locally |
| `voice_oohs-mp3.js` | `voice_oohs` | **Not bundled** — CDN-only |

`voice_oohs` is listed as a selectable voice in `PLAYBACK_INSTRUMENTS`
(`frontend/src/playback/soundfont.ts`) but has **no local copy in this
directory**. Selecting it falls through the bundled-asset lookup and depends
entirely on the CDN mirrors in `SOUNDFONT_URL_TEMPLATES`. **In an
offline/packaged build, selecting "Voice Oohs" will fail on every mirror and
silently fall back to piano** (the documented instrument-load fallback
chain — see `SoundfontLoader.loadNoteMapForInstrument`).

This is a deliberate decision, not an oversight: each bundled instrument
file is ~2.6–2.8 MB, and shipping a third ~2.8 MB binary for a voice that
mostly duplicates `choir_aahs` wasn't judged worth the bundle-size cost.
If that tradeoff changes, follow "Adding a new bundled voice" below to add
`voice_oohs-mp3.js` (or any other instrument) locally.

## Upstream source

Both bundled files were pulled from
[`gleitz/midi-js-soundfonts`](https://github.com/gleitz/midi-js-soundfonts),
`FluidR3_GM/` directory (the same repo the CDN mirrors in
`SOUNDFONT_URL_TEMPLATES` fall back to). That repo re-packages notes from the
FluidR3_GM `.sf2` soundfont as base64-encoded MP3 samples inside a
MIDI.js-format `.js` file — see the format note in `soundfont.ts`'s header
comment.

## Licence

- The `gleitz/midi-js-soundfonts` repository ships its own `LICENSE.txt`
  (MIT), which covers the repo's code/tooling.
- The FluidR3_GM soundfont audio content itself is documented upstream as
  released under the **Creative Commons Attribution 3.0 license**, which
  requires attribution to the original FluidR3 SoundFont (`FluidR3_GM.sf2`,
  created by Frank Wen) when redistributed.

**Attribution:** Samples in this directory are derived from the FluidR3_GM
soundfont (`FluidR3_GM.sf2`) by Frank Wen, redistributed via
`gleitz/midi-js-soundfonts` under CC BY 3.0.

**Unable to confirm:** we could not locate a single canonical, versioned
licence file inside `gleitz/midi-js-soundfonts` itself (no `LICENSE.md` at
the paths checked); the CC BY 3.0 statement above reflects the licence text
published on the project's GitHub Pages site as of the date this README was
written (2026-08-22). If you rely on this for compliance purposes, re-verify
against the current upstream source before redistributing further.

## Adding a new bundled voice

To bundle an additional GM instrument (e.g. to bundle `voice_oohs` locally
instead of leaving it CDN-only):

1. Download `{instrument}-mp3.js` from upstream, e.g.:
   ```
   curl -O https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/voice_oohs-mp3.js
   ```
   (`{instrument}` must match the GM instrument id exactly — these ids are
   the filenames used by `gleitz/midi-js-soundfonts` and by
   `buildSoundfontUrls()` in `soundfont.ts`.)
2. Drop the downloaded file into this directory
   (`frontend/public/soundfonts/FluidR3_GM/{instrument}-mp3.js`) unmodified.
3. If the instrument isn't already selectable, add its id to
   `PlaybackInstrumentId` and add an entry to `PLAYBACK_INSTRUMENTS` in
   `frontend/src/playback/soundfont.ts`. If it's already selectable (like
   `voice_oohs`), no code change is needed — `buildSoundfontUrls()` already
   points at `/soundfonts/FluidR3_GM/{instrument}-mp3.js` first, so the new
   local file is picked up automatically ahead of the CDN mirrors.
4. Update the table above and this file's attribution note if the new
   instrument comes from a different upstream source.
5. Confirm you're satisfied with the CC BY 3.0 attribution requirement (or
   whatever licence applies to the new source) before shipping the binary.
