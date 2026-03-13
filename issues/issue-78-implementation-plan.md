# Issue #78 Implementation Plan: Pitch interpretation layer (median filter + onset settling + tolerance hysteresis)

## Source issue
- https://github.com/leonarduk/sing-attune/issues/78
- Title: **Pitch interpretation layer — median filter + onset settling**

## Current baseline (from repo)
- Backend emits raw pitch frames `{t,midi,conf}` and remains transport-focused.
- Frontend is authoritative for pitch interpretation/rendering (`docs/milestone-2-validation.md`).
- Dot colour is currently stateless thresholding in `classifyPitchColor()` (`frontend/src/pitch/accuracy.ts`):
  - grey if confidence below threshold
  - green if ≤50 cents, amber if ≤100 cents, else red
- `PitchOverlay.pushFrame()` currently classifies every incoming frame immediately and renders dot colour without note-onset grace logic.

Given the architecture note in docs, issue #78 should be implemented in the **frontend pitch interpretation path** before colour classification/rendering.

---

## Goals
1. Stabilize displayed pitch against vibrato and transient octave jumps via a 5-frame median filter.
2. Suppress grading during the first 150ms of each expected-note onset.
3. Add hysteresis around in-tune boundary to prevent red/green flicker:
   - in-tune entry: ±25 cents
   - in-tune exit: ±35 cents
4. Preserve responsiveness to genuine pitch movement (note transitions should still register quickly).
5. Add deterministic unit tests for vibrato, octave-error suppression, onset settling, and hysteresis behaviour.

---

## Design approach

### 1) Add a dedicated interpretation state machine module
Create a new module that owns short history and stateful classification decisions, instead of expanding `accuracy.ts` into a stateful utility.

**Proposed API (conceptual):**
- `createPitchInterpreter(config?)`
- `interpreter.processFrame({ t, midi, conf, expectedMidi, expectedNoteKey }) => { filteredMidi, color, suppressDot? }`
- `interpreter.reset()` for stop/seek/part-change contexts

### 2) Median filter window
- Maintain rolling window of recent sung MIDI values (voiced/confident frames only).
- Median over last 5 samples (or fewer during warm-up, with predictable bootstrap policy).
- Use filtered MIDI for cents-error computation and rendered Y position.

### 3) Onset settling window per expected note
- Detect note boundary using note identity (`beat_start + midi + part`) from current expected note.
- For first 150ms after new expected note starts, output neutral colour (`grey`) while still optionally drawing dot (or suppress entirely if desired by UX policy).
- Reset settling timer on each new expected note.

### 4) Hysteresis implementation
Replace stateless green threshold with a stateful “in-tune latch”:
- If currently out-of-tune, require `abs(cents) <= 25` to enter green.
- If currently in-tune, stay green until `abs(cents) > 35`.
- Amber/red split can remain on existing broader bands, but green eligibility must go through hysteresis state.
- Confidence gate (`grey`) always has priority and should not mutate in-tune state unless explicitly desired (document choice in tests).

### 5) Overlay integration
- `PitchOverlay` will:
  - resolve expected note at beat (existing behaviour)
  - pass raw frame + expected note context into interpreter
  - render using interpreter output colour and filtered MIDI
- Reset interpreter on:
  - `clear()`
  - `updatePart()`
  - any transport restart path that currently clears dots (if routed through overlay API)

---

## File-by-file change plan

### 1) `frontend/src/pitch/interpretation.ts` **(new)**
**Why:** Isolate stateful logic (median filter, onset settling, hysteresis) from pure utilities.

**Planned contents:**
- Config constants and types:
  - `MEDIAN_FILTER_FRAMES = 5`
  - `ONSET_SETTLE_MS = 150`
  - `GREEN_ENTRY_CENTS = 25`
  - `GREEN_EXIT_CENTS = 35`
- Interpreter class/factory with internal state:
  - rolling MIDI buffer
  - current note identity and onset timestamp
  - in-tune latch boolean
- Small pure helpers:
  - median calculation
  - cents offset calculation
  - note-key construction

### 2) `frontend/src/pitch/interpretation.test.ts` **(new)**
**Why:** Cover acceptance criteria directly with deterministic synthetic input.

**Planned tests:**
- **Synthetic vibrato stabilization**
  - input around target with ±50 cents oscillation at 5Hz sampling cadence
  - assert filtered output variance and colour flicker are reduced
- **Octave error suppression**
  - inject isolated ±12 semitone outlier frame among stable frames
  - assert median output remains near target and does not trigger large false deviation
- **Onset settling**
  - first 150ms of new expected note grades as neutral (grey/suppressed)
  - grading resumes after threshold
- **Hysteresis boundaries**
  - entry requires ≤25 cents
  - once green, remains green through 26–35 cents
  - exits only after >35 cents
- **State reset**
  - reset clears history and hysteresis latch

### 3) `frontend/src/pitch/overlay.ts`
**Why:** Inject interpretation layer before rendering.

**Planned modifications:**
- Instantiate interpreter as a private field.
- In `pushFrame()`:
  - compute expected note as today
  - build expected-note identity and pass to interpreter
  - use returned `filteredMidi` for Y position
  - use returned colour for dot
- In lifecycle methods (`clear`, `updatePart`, possibly `destroy`), call interpreter reset.

### 4) `frontend/src/pitch/overlay.test.ts`
**Why:** Ensure overlay-level integration and reset wiring are correct.

**Planned modifications:**
- Add tests validating interpreter reset is triggered on part switch and clear.
- Add lightweight integration test that `pushFrame()` uses interpreted/filtered value path (can be done via spies or deterministic state).

### 5) `frontend/src/pitch/accuracy.ts`
**Why:** Keep it as pure/stateless primitives or trim responsibilities.

**Planned modifications:**
- Retain `expectedNoteAtBeat()`.
- Refactor/rename `classifyPitchColor()` to represent non-hysteretic base bands (if still used).
- Remove direct responsibility for final green decision if migrated to interpreter.

### 6) `frontend/src/pitch/accuracy.test.ts`
**Why:** Align tests with any refactor in `accuracy.ts` and avoid duplicated hysteresis assertions.

**Planned modifications:**
- Keep tests for confidence gate and non-stateful helpers that remain.
- Move/new stateful boundary tests to `interpretation.test.ts`.

### 7) `frontend/src/main.ts` *(optional/minimal)*
**Why:** Only if overlay reset hooks need explicit calls on transport events not already covered by existing `clear()` calls.

**Possible modification:**
- Ensure stop/seek/restart flows call overlay clear consistently so interpreter state resets with visual trail.

### 8) `docs/milestone-2-validation.md` *(optional but recommended)*
**Why:** Document updated frontend-authoritative interpretation behaviour and thresholds.

**Possible modification:**
- Add note describing the new interpretation layer and its constants.

---

## Implementation sequence
1. Add `interpretation.ts` with unit-tested primitives and state machine.
2. Add `interpretation.test.ts` and get tests green in isolation.
3. Integrate interpreter into `overlay.ts`.
4. Update `overlay.test.ts` and `accuracy*` tests for new responsibility split.
5. Run full frontend test/build validation.
6. (Optional) update docs.

---

## Validation plan

### Automated checks
- `cd frontend && npm test`
- `cd frontend && npm run build`

### Acceptance criteria mapping
- **Vibrato stabilization:** `interpretation.test.ts` synthetic ±50c @ 5Hz case.
- **Octave suppression:** `interpretation.test.ts` outlier-frame case.
- **Stable filtered output + legitimate changes preserved:**
  - sequence test with real note step change (e.g., C4→D4) confirms adaptation within expected frames.
- **Hysteresis no flicker:** boundary-chatter test around ±30 cents should stay latched green when appropriate.
- **Onset settling:** time-gated neutral period of first 150ms per note.

---

## Risks & mitigations
- **Risk:** Over-smoothing masks fast intended note transitions.
  - **Mitigation:** Keep window at 5 frames only, add step-change tests.
- **Risk:** Ambiguity whether onset settling should hide dot or show grey dot.
  - **Mitigation:** choose one explicit policy and encode in tests + docs.
- **Risk:** Confidence dropouts interacting with hysteresis state.
  - **Mitigation:** define and test whether latch persists through grey frames.

---

## Definition of done for this issue
- Frontend pitch overlay uses interpreted pitch (not raw frame) for grade/render decision.
- 5-frame median filter, 150ms onset settling, and ±25/±35 hysteresis are implemented.
- Unit tests explicitly cover vibrato, octave outlier suppression, hysteresis boundaries, and onset settling.
- Frontend test suite and build pass.
