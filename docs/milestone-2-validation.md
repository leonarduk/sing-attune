# Milestone 2 DoD validation (issue #48)

## Architecture clarification

- **Pitch interpretation is frontend-authoritative in v0.2.**
- Backend WebSocket remains a raw pitch stream: `{t,midi,conf}`.
- Frontend computes expected note-at-beat and colour classification for overlay rendering.

## Runtime checklist

- [x] Load Homeward Bound Part I MusicXML.
- [x] Play, pause, resume, stop.
- [x] Rewind.
- [x] Seek by measure using keyboard arrows.
- [x] Tempo changes applied.
- [x] Transpose changes applied.
- [x] Part switching works.
- [x] Overlay suppresses dots during rests.
- [x] No browser console errors observed during validation flow.

## Notes

- Validation run performed with the new in-app settings panel visible.
- Settings verified: mic device selection, confidence threshold, trail length, and engine status display.
