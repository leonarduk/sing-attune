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

## Evidence

### Settings panel screenshot

Captured with Playwright while opening the app and toggling the Settings panel:

- Artifact path: `browser:/tmp/codex_browser_invocations/ecad9100900f35f8/artifacts/artifacts/settings-panel.png`

### Frontend verification logs

```text
$ cd frontend && npm test
Test Files  7 passed (7)
Tests       51 passed (51)

$ cd frontend && npm run build
✓ built in 5.89s
```

## Notes

- Validation run performed with the in-app settings panel visible.
- Settings verified: mic device selection fallback logic, confidence threshold clamp, trail length, and engine status display.
