# Issue #79 Implementation Plan: Target Note Band Overlay (Pitch Graph vs Score)

## Goal
Implement a moving **target-note tolerance band** on the pitch overlay so singers can compare their live pitch against the expected score pitch in real time.

## Scope from issue
- Render a horizontal band at the expected note.
- Band shows a tolerance window (default ±50 cents, configurable).
- Band follows score timing driven by playback/audio synchronization.
- Keep sung pitch trace visible above/with contrast against the band.

---

## Current state (repo analysis)
- `PitchOverlay` currently renders pitch **dots** only, with color derived from note accuracy and confidence threshold. No target band is rendered.
- Expected note lookup is already available via `expectedNoteAtBeat(...)`.
- Real-time cursor and pitch timing are already synchronized via playback engine timing and frame projection.
- Settings panel currently supports confidence threshold and trail length, but not band tolerance.

This means the feature can be built mostly in the existing frontend overlay path without backend schema changes.

---

## Proposed implementation

## 1) Extend overlay settings to include target-band tolerance
### Files to change
- `frontend/src/pitch/overlay.ts`
- `frontend/src/main.ts`
- `frontend/index.html`

### Changes
- Add new overlay setting field, e.g. `targetBandCents`.
- Add min/max/default constants (suggested defaults: min 10, max 200, default 50).
- Update `normalizeOverlaySettings(...)` to clamp and sanitize this value.
- Add a slider/input in settings UI for target band tolerance.
- Persist the setting in the in-memory `overlaySettings` object and apply through `pitchOverlay.applySettings(...)`.

### Why
Acceptance criteria explicitly requires configurable tolerance width.

---

## 2) Render expected-note target band in `PitchOverlay`
### Files to change
- `frontend/src/pitch/overlay.ts`

### Changes
- Track latest timing context needed to draw target band continuously:
  - either (A) store latest projected beat + x samples and compute in redraw
  - or (B) store latest frame-derived beat/x and draw band at that x during redraw.
- Add a helper that maps cents to Y-range in MIDI space:
  - `midiOffset = cents / 100`
  - band top/bottom from `expectedMidi ± midiOffset` converted via `midiToY(...)`.
- In `redraw()`:
  1. Determine current beat at render time (aligned with cursor timing model).
  2. Resolve expected note with `expectedNoteAtBeat(...)`.
  3. Draw semi-transparent blue rectangular band spanning the viewport X area (or a short forward window if desired by UX) at target Y range.
  4. Draw sung pitch dots after the band so dots remain legible.
- Add style constants for contrast (e.g. fill `rgba(33, 150, 243, 0.25)`, optional border stroke).

### Why
This directly implements the visual behavior and layering required by the issue.

---

## 3) Ensure timing source remains AudioContext-synced
### Files to change
- `frontend/src/main.ts`
- `frontend/src/pitch/overlay.ts`

### Changes
- Pass sufficient timing context into overlay so band reflects **current score time**, not stale frame time.
- Preferred approach:
  - expose/update a method on `PitchOverlay`, e.g. `setPlaybackBeat(beat: number, cursorX: number)` from existing cursor RAF loop.
  - overlay redraw uses this beat/cursor sample to position target band each animation cycle.
- Keep fallback behavior when playback is paused/stopped (band hidden or pinned to current beat).

### Why
Issue asks for cursor timing driven by `AudioContext.currentTime` + sync offset. Existing engine clock is already the authoritative source; band should follow that same source.

---

## 4) Keep sung pitch trace and target band visually distinct
### Files to change
- `frontend/src/pitch/overlay.ts`

### Changes
- Enforce drawing order: band first, dots second.
- Tune opacity/line width/dot radius to preserve contrast in dense passages.
- Optionally add a subtle band outline for clarity on white score background.

### Why
Acceptance criteria requires clear relationship between sung pitch and expected band.

---

## 5) Unit tests for settings and rendering math
### Files to change
- `frontend/src/pitch/overlay.test.ts`
- `frontend/src/pitch/accuracy.test.ts` (optional if band logic reuses shared helpers)
- potentially add: `frontend/src/pitch/target-band.test.ts` (if extracting helpers)

### Test cases
- `normalizeOverlaySettings` clamps `targetBandCents` correctly.
- Band Y-range calculation from expected MIDI and tolerance cents is correct.
- No band rendered during rests (`expectedNoteAtBeat` is `null`).
- Band selection follows changing expected note across beat boundaries.
- Dots remain rendered when band is active (ordering/visibility smoke test via mocked canvas calls).

### Why
This is a visually sensitive feature with mathematical mapping; tests prevent regressions.

---

## 6) Manual validation checklist
### Commands
- `cd frontend && npm test`
- `cd frontend && npm run build`

### Runtime checks
- Load a score, play, and confirm the blue target band moves with the cursor.
- Change tolerance slider and verify band thickness updates immediately.
- Confirm behavior during rests (no misleading band unless intentionally designed otherwise).
- Confirm transpose still reflects correct expected target pitch.
- Confirm no performance degradation while receiving real-time pitch frames.

---

## File-by-file implementation impact

### Must-change
1. `frontend/src/pitch/overlay.ts`
   - Add target-band config and rendering.
   - Add playback beat/cursor update hook (or equivalent timing bridge).
2. `frontend/src/main.ts`
   - Feed timing + tolerance setting into overlay.
   - Wire new settings control events.
3. `frontend/index.html`
   - Add target-band tolerance UI control in settings panel.
4. `frontend/src/pitch/overlay.test.ts`
   - Extend tests for settings normalization and (if feasible) canvas behavior.

### Likely-change (depending on refactor choice)
5. `frontend/src/pitch/accuracy.ts`
   - Only if helper extraction for cents/midi mapping is useful.
6. `frontend/src/pitch/accuracy.test.ts`
   - Only if logic moved/shared.

### Optional docs update
7. `docs/` (new or existing note on pitch overlay behavior)
   - Document default tolerance and how it is configured.

---

## Risks and mitigations
- **Risk:** Band tied to incoming frame timestamps may lag when confidence drops / sparse frames.
  - **Mitigation:** Drive band position from playback beat (AudioContext clock), not only frame arrivals.
- **Risk:** Visual clutter on dense score sections.
  - **Mitigation:** Keep alpha low and draw dots above band.
- **Risk:** Y-mapping drift if pitch range is narrow/wide.
  - **Mitigation:** Reuse existing `midiToY` mapping consistently for both dots and band edges.

---

## Definition of done
- Blue target-note band visible and updates with playback progression.
- Tolerance width is user-configurable and defaults to ±50 cents.
- Timing stays aligned with AudioContext-driven cursor.
- Existing pitch dots and readout continue functioning.
- Frontend tests pass and build succeeds.
