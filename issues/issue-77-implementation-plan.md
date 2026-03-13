# Issue #77 — WebSocket pitch consumer: full implementation plan

## Objective
Wire backend WebSocket pitch frames (`/ws/pitch`) into a clock-synchronised frontend consumer so the pitch graph renders smooth real-time traces with clean pause/resume behaviour and no stale artifacts.

## Scope and assumptions
- This plan targets the existing architecture where:
  - Backend emits pitch frames as `{ t, midi, conf }` with `t` in playback-relative milliseconds.
  - Frontend renders overlay dots on the score canvas via `PitchOverlay`.
- The implementation will conform to `docs/sync-protocol.md` timing rules.
- This issue is frontend-heavy; backend changes are limited to optional observability/contract clarifications if gaps are discovered during implementation.

---

## Acceptance criteria mapping

1. **Live pitch frames appear on graph in real time**
   - Create an explicit pitch stream consumer that pushes parsed frames into overlay immediately on message receipt.
   - Keep reconnect logic and non-frame filtering (`status`, `ping`) resilient.

2. **No drift between audio clock and graph timestamps**
   - Introduce a dedicated timestamp mapper that converts frame `t_ms` to a graph position anchored to `AudioContext.currentTime`.
   - Capture/re-anchor timing on play, pause, resume, stop, seek, and tempo changes according to sync protocol.

3. **No pause/resume rendering artifacts**
   - Buffer/fence frames at transport transitions.
   - Clear or segment traces on resume to prevent ghost continuity across paused intervals.
   - Prune stale frames outside visible time window.

---

## Design changes

### 1) Introduce a dedicated pitch stream controller
Create a small controller layer to decouple WebSocket I/O from UI concerns.

**Responsibilities:**
- Manage socket lifecycle (connect/reconnect/close).
- Parse payloads and ignore non-frame messages.
- Maintain frame sequencing and optional transition fences.
- Publish frame events to main UI code.

**Why:**
Current message handling in `main.ts` mixes transport, parsing, and rendering, making sync-state transitions hard to reason about and test.

### 2) Introduce a clock alignment utility
Add a focused utility that translates backend frame time (`t_ms`) to frontend timeline projection based on protocol anchors.

**Responsibilities:**
- Capture play anchor (`audioStartTime`) when `/playback/start` resolves.
- Update resume anchor from `/playback/resume` response (`t_ms`) + current audio time.
- Expose helpers for:
  - `frameToAudioTime(frameTMs)`
  - `frameToBeat(frameTMs, tempoMarks)`
  - optional `frameFreshness(frameTMs, nowAudioTime, visibleWindowMs)`

### 3) Update pause/resume handling semantics
On pause/resume/seek, enforce clean overlay continuity rules.

**Rules:**
- **Pause:** stop adding new points; keep existing trail until aged out.
- **Resume:** avoid joining pre-pause and post-resume points as one continuous trace segment.
- **Seek/Stop/New Play:** clear overlay points and reset timing anchors.

### 4) Prune stale points by visible time window
Ensure any frame older than current visible window is dropped before rendering.

**Implementation options:**
- Extend overlay prune logic from pure wall-clock aging to include frame timeline age.
- Or drop in consumer before pushing to overlay.

Preferred: drop in consumer first (cheap, deterministic) and keep overlay prune as visual fallback.

---

## File-by-file implementation plan

### Explicit file list (for this issue)

#### Required code changes
- `frontend/src/main.ts`
- `frontend/src/pitch/socket.ts`
- `frontend/src/pitch/overlay.ts`

#### Required test changes
- `frontend/src/pitch/socket.test.ts`
- `frontend/src/pitch/overlay.test.ts`

#### Conditionally required (only if extraction/refactor is chosen)
- `frontend/src/pitch/timeline-sync.ts` *(new)*
- `frontend/src/pitch/timeline-sync.test.ts` *(new)*

#### Conditionally required (only if existing helpers are insufficient)
- `frontend/src/score/timing.ts`
- `frontend/src/score/timing.test.ts`
- `frontend/src/transport/controls.ts`

#### Documentation update (only if protocol clarification is needed)
- `docs/sync-protocol.md`

### A. Frontend runtime code (primary)

1. **`frontend/src/main.ts`**
- Replace inline pitch socket handling with new stream controller.
- Integrate clock alignment helper into:
  - Play start flow
  - Pause flow
  - Resume flow
  - Stop/rewind/seek flow
- Remove/replace `frameXPosition` estimation path if superseded by timeline mapper.
- Ensure overlay reset points are explicitly called at transport boundaries.
- Preserve pitch readout updates (`Detected: ...`) using latest valid frame.

2. **`frontend/src/pitch/socket.ts`**
- Evolve from only parsing helpers to a richer socket consumer API, for example:
  - typed discriminated payloads (`frame`, `connected`, `ping`, `unknown`)
  - connection callbacks for open/close/retry
  - optional buffering/fence support across pause/resume
- Keep `reconnectDelayMs` and harden parse guards.

3. **`frontend/src/pitch/overlay.ts`**
- Add support for segment breaks (if rendering transitions become line-based).
- Add explicit stale-frame rejection hook (if not done entirely in consumer).
- Keep confidence threshold handling unchanged unless required by new ingestion contract.

4. **`frontend/src/score/timing.ts`**
- Add helper(s) used by new timestamp mapper if existing `elapsedToBeat` primitives are insufficient.
- Ensure conversions remain deterministic across tempo multipliers.

5. **`frontend/src/transport/controls.ts`** *(possible minor update)*
- If needed, expose richer response typing from playback endpoints (`{ state, t_ms }`) to support stronger anchor handling in `main.ts`.

### B. Frontend tests

6. **`frontend/src/pitch/socket.test.ts`**
- Add coverage for:
  - filtering `{"status":"connected"}` and `{"ping":true}`
  - malformed payload rejection
  - reconnect behaviour continuity
  - any fence/buffering semantics

7. **`frontend/src/pitch/overlay.test.ts`**
- Add tests for pause/resume artifact prevention behaviour (e.g., segment reset or clear policy).
- Add stale window pruning tests (old points dropped).

8. **`frontend/src/score/timing.test.ts`**
- Add tests for any new timestamp/beat mapping utilities used by the consumer.

9. **`frontend/src/main.ts` tests (new file likely required)**
- Add isolated unit tests for playback transition handling logic by extracting pure helper functions from `main.ts` (recommended).
- If direct `main.ts` testing is too integration-heavy, create and test dedicated helper module(s), e.g.:
  - `frontend/src/pitch/timeline-sync.ts`
  - `frontend/src/pitch/timeline-sync.test.ts`

### C. Documentation

10. **`docs/sync-protocol.md`** *(only if behaviour details need clarification discovered during implementation)*
- Clarify any exact frontend anchor moments used in code (especially resume and seek edge-cases) to keep implementation and protocol in sync.

---

## Implementation phases

### Phase 1 — Refactor for testability (no behaviour change)
- Extract current WebSocket event handling from `main.ts` into a reusable pitch stream module.
- Keep existing runtime behaviour intact.
- Add baseline tests around payload parsing and reconnect delay.

### Phase 2 — Add sync-aware timeline mapping
- Implement play/resume anchor model using `AudioContext.currentTime` + backend `t_ms`.
- Route all incoming frames through mapper before overlay push.
- Validate frame->beat mapping under tempo multiplier changes.

### Phase 3 — Pause/resume artifact prevention
- Add transition fences/segment breaks.
- Ensure clear behaviour on stop/rewind/seek/new-play.
- Add tests for no ghost traces across resume.

### Phase 4 — Stale frame window pruning
- Enforce visible window cutoff before rendering.
- Confirm sustained sessions do not accumulate stale render artifacts.

### Phase 5 — Final hardening
- Run full frontend test suite and lint/type checks.
- Validate in browser with manual pause/resume and reconnection scenarios.
- Update protocol doc only if implementation surfaces ambiguity.

---

## Detailed test plan

### Unit tests
- Socket parser and message classification.
- Reconnect backoff progression and cap.
- Timeline sync helper with deterministic synthetic timestamps.
- Overlay pruning / artifact controls.

### Integration-style frontend tests
- Simulated sequence:
  - start -> frames -> pause -> wait -> resume -> frames
  - assert no stale pre-pause frames rendered in post-resume segment beyond policy.
- Simulated reconnect while playing and while paused.

### Manual validation checklist
- Start playback: pitch dots appear within one frame cadence.
- Pause for 5+ seconds: no moving pitch trace during pause.
- Resume: trace continues from correct musical time without ghosting.
- Stop then Play: prior session dots do not reappear.
- Seek forward/back: overlay aligns to new location with no stale points.

---

## Risks and mitigations

1. **Anchor drift caused by asynchronous API round-trips**
- Mitigation: centralise anchor capture and use backend `t_ms` responses for resume/seek rebasing.

2. **Visual discontinuities from cursor pixel estimation**
- Mitigation: prefer beat/time-domain mapping first, then project to x-coordinate with deterministic helper; fallback to cursor estimate only when required.

3. **Over-coupling between transport and UI rendering**
- Mitigation: stream controller emits typed frame events; UI consumes events only.

4. **Flaky tests due to real timers**
- Mitigation: use fake timers in Vitest for reconnect and trail/pruning logic.

---

## Deliverables
- Refactored, tested pitch WebSocket consumer integrated with overlay rendering.
- Sync-protocol compliant timestamp mapping in frontend.
- Verified pause/resume behaviour without ghost traces.
- Added/updated test coverage for parsing, mapping, transitions, and pruning.
- Protocol doc updates only if implementation reveals ambiguity.
