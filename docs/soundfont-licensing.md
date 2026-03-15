# Soundfont licence audit (Issue #113)

## Current playback asset used by sing-attune

- Runtime file: `frontend/public/soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js`
- Source project: `gleitz/midi-js-soundfonts`
- Source family: `FluidR3_GM`
- Instrument file: `acoustic_grand_piano-mp3.js`

## Upstream licence statements reviewed

- `gleitz/midi-js-soundfonts` README states:
  - FluidR3 soundfont is released under **Creative Commons Attribution 3.0** (CC BY 3.0).
  - Musyng Kite and FatBoy are listed as **CC BY-SA 3.0**.
- sing-attune currently uses the **FluidR3_GM** variant, not MusyngKite.

Reference used during implementation:
- https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/README.md

## Redistribution conclusion

For the currently bundled asset (`FluidR3_GM/acoustic_grand_piano-mp3.js`), redistribution in packaged apps is permitted under CC BY 3.0 provided attribution is included.

## Required attribution action

Attribution is included in this repository's `NOTICE` file.

## Packaging/offline behaviour

The frontend now loads `/soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js` first, which allows packaged Electron/Vite builds to play back offline without CDN access.
