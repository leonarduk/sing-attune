# Issue #76 Implementation Plan — Pitch Graph Canvas (Semitone Grid + f0 Trace)

## Source Issue
- GitHub issue: https://github.com/leonarduk/sing-attune/issues/76
- Title: **Pitch graph canvas component — semitone grid + f0 trace**

## Goal
Add a dedicated pitch graph `<canvas>` visualization that shows incoming `(t, f0)` data as a scrolling, continuous line over a chromatic semitone grid (C2–C6), with octave labels and color-coded accuracy against the active target note.

## Current State (Repository Baseline)
- The app already has a **score overlay canvas** (`PitchOverlay`) that draws fading pitch dots directly over notation, not in a time-window graph. This is a useful reference for confidence filtering, expected-note lookup, and canvas lifecycle management.
- Pitch color logic currently classifies at broader thresholds (green/amber/red) and will need graph-specific behavior (green/red/grey) with ±25 cents tolerance for “in tune”.
- WebSocket pitch ingestion already exists and can feed real-time graph updates, but issue acceptance requires **synthetic test input without WebSocket dependency**.

## Proposed Design

### 1) New Graph Component
Create a new class (e.g. `PitchGraphCanvas`) that owns:
- Canvas setup + DPR scaling.
- Circular/ring buffer of time-stamped pitch samples.
- Rendering pipeline:
  1. clear background,
  2. draw semitone Y-grid + octave emphasis + labels,
  3. draw 1-second X-grid lines,
  4. draw pitch trace segments with per-segment color.

### 2) Coordinate System
- **Y-axis:** MIDI (or frequency converted to MIDI) from C2 (36) to C6 (84).
- **X-axis:** rolling window of configurable seconds (default `10`).
- Graph time anchor should use monotonic clock (`performance.now()` or frame timestamps) and render only samples where `sample.t >= now - windowSec`.

### 3) Trace Color Rules
For each sample (or segment endpoint), compute state:
- `grey`: no active target note at that time.
- `green`: target exists and `|cents error| <= 25`.
- `red`: target exists and `|cents error| > 25`.

### 4) Data Inputs
- Primary live path: consume existing pitch frames currently parsed in `main.ts`.
- Dev/testing path: a synthetic generator (e.g. sine sweep, stepped scale, jittered target-follow curve) to validate rendering independent of backend socket.

### 5) Integration Strategy
- Mount the graph in the UI as a separate panel (likely below toolbar and above/below score area depending current layout constraints).
- Keep existing `PitchOverlay` behavior intact initially to reduce regression risk; graph can coexist behind a feature flag or always-on if UX approves.

## File-by-File Change Plan

### Frontend UI + wiring
1. **`frontend/index.html`**
   - Add DOM container/canvas host for pitch graph.
   - Add minimal controls if needed (window length, synthetic mode toggle for dev).
   - Add CSS for graph panel sizing, background contrast, labels/legend.

2. **`frontend/src/main.ts`**
   - Instantiate and own lifecycle of the new graph class.
   - Forward pitch frames to graph (`pushFrame`/`appendSample`).
   - Sync graph “now” updates via RAF loop.
   - On play/stop/score load/part change, reset graph state appropriately.
   - Add optional synthetic-source toggle path for acceptance testing without WebSocket.

### New pitch graph module(s)
3. **`frontend/src/pitch/graph.ts`** *(new)*
   - `PitchGraphCanvas` class implementation.
   - Axis constants (`C2..C6`, octave markers), rendering helpers, sample storage, pruning, resize handling.
   - Public API (proposed):
     - `constructor(container: HTMLElement, opts?: PitchGraphOptions)`
     - `pushFrame(frame: PitchFrame, expectedMidi: number | null): void`
     - `tick(nowSec: number): void` (or `render(nowSec)`)
     - `setWindowSeconds(sec: number): void`
     - `clear(): void`
     - `destroy(): void`

4. **`frontend/src/pitch/graph-colors.ts`** *(new, optional split)*
   - Encapsulate cents-error classification and color mapping for graph semantics.
   - Keeps logic testable and separate from canvas rendering.

5. **`frontend/src/pitch/synthetic.ts`** *(new)*
   - Deterministic synthetic frame generators:
     - sine sweep across a MIDI range,
     - fixed-step semitone staircase,
     - optional noisy in-tune/out-of-tune patterns.
   - Expose a small generator API so tests/dev mode can inject frames consistently.

### Reuse/compatibility changes
6. **`frontend/src/pitch/accuracy.ts`**
   - Keep existing overlay behavior stable.
   - Add graph-specific helper(s) if shared logic is desirable (e.g. `centsError`, `expectedNoteAtBeat` reuse), but avoid changing current overlay thresholds unless intentionally coordinated.

### Tests
7. **`frontend/src/pitch/graph.test.ts`** *(new)*
   - Unit tests for:
     - x/y coordinate mapping boundaries,
     - pruning samples outside rolling window,
     - color classification around ±25 cents edges,
     - octave/grid marker derivation.

8. **`frontend/src/pitch/synthetic.test.ts`** *(new)*
   - Validate synthetic generator determinism and expected range.

9. **`frontend/src/main.ts` tests** *(new or existing harness extension if present)*
   - Smoke test graph initialization and teardown path if current setup supports integration-level DOM tests.

### Documentation
10. **`README.md`**
    - Add short section for pitch graph panel and any dev-mode synthetic feed usage.

11. **`docs/` (optional new doc, e.g. `docs/pitch-graph.md`)**
    - Rendering model, timing assumptions, and known limitations.

## Execution Phases

### Phase 1 — Scaffolding
- Add graph container + class skeleton + resize/render loop.
- Render static semitone/octave/second grid with no live data.

### Phase 2 — Trace Pipeline
- Wire incoming pitch frames from `main.ts`.
- Implement rolling window and continuous polyline drawing.

### Phase 3 — Target-Aware Coloring
- Compute target note per frame time and apply green/red/grey rule with ±25 cents threshold.
- Verify behavior at note boundaries/rest gaps.

### Phase 4 — Synthetic Validation Mode
- Add deterministic synthetic source and toggle path so graph can run without WebSocket/backend.
- Ensure acceptance criteria can be demonstrated offline.

### Phase 5 — Test + Polish
- Add unit tests for mapping/classification/pruning.
- Tune rendering performance (avoid full object churn; prune incrementally).
- Document usage.

## Acceptance Criteria Mapping
- **Canvas renders with synthetic test data** → covered by `synthetic.ts` + test toggle + unit tests.
- **Grid lines and octave labels correct** → explicit grid renderer with octave emphasis tests.
- **Trace scrolls smoothly** → rolling window + RAF-driven redraw.
- **No WebSocket dependency for initial testing** → synthetic source path independent of socket.

## Risks & Mitigations
- **Risk:** Canvas redraw cost grows with sample count.  
  **Mitigation:** bounded rolling buffer and incremental pruning.
- **Risk:** Timebase mismatch between pitch frame `t` and UI clock.  
  **Mitigation:** normalize all graph timestamps to a single monotonic timeline in `main.ts`.
- **Risk:** Coupling with score timing for expected note lookup introduces edge artifacts.  
  **Mitigation:** central helper for beat mapping and explicit boundary tests.

## Definition of Done (Implementation)
- New graph visible in UI with semitone+octave grid and 1s vertical grid.
- Continuous f0 trace scrolling over a default 10s window.
- Trace color follows green/red/grey rule with ±25 cents threshold.
- Synthetic mode available and documented for backend-free validation.
- Unit tests added for graph logic and synthetic generators.
