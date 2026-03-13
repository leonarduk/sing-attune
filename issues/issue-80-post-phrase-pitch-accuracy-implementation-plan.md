# Issue #80 Implementation Plan: Post-phrase pitch accuracy summary

## Source issue
- GitHub issue: https://github.com/leonarduk/sing-attune/issues/80
- Title: **Post-phrase pitch accuracy summary**

## Goal
After each phrase ends, compute and show a phrase-level pitch summary that includes:
1. Percentage of time within pitch tolerance.
2. Per-note feedback badges (🟢 / 🟡 / 🔴).
3. Directional diagnostics for consistently **flat** or **sharp** notes.

## Scope clarification for this PR
- This PR intentionally delivers a **file-level implementation plan only** and does **not** ship runtime feature code.
- The acceptance criteria from issue #80 remain the implementation target; they are mapped below so the follow-up implementation PR can be validated directly against them.
- To avoid ambiguity in review:
  - Planning done in this PR.
  - Feature implementation + tests to be completed in a follow-up PR that references this plan.

## Current-state assessment (relevant architecture)
- Frontend already computes real-time note matching and color classification (`expectedNoteAtBeat`, `classifyPitchColor`) from incoming raw pitch frames.
- Frontend overlays dot colors but does not persist frame history into phrase/note analytics.
- Backend streams raw pitch frames only; this is intentionally score-agnostic.
- Score model includes note timing and measure data, but no explicit phrase boundaries.

## Implementation strategy
Keep issue #80 logic **frontend-centric** to preserve the existing “raw backend, interpreted frontend” boundary:
- Backend remains unchanged for v1 implementation.
- Frontend introduces phrase segmentation and analytics from:
  - Score note timing (`beat_start`, `duration`, `measure`)
  - Playback beat clock
  - Incoming pitch frames

If future milestones need server-side persistence/export, add backend APIs in a follow-up issue.

---

## Detailed plan

### 1) Define phrase boundaries
Because phrases are not encoded in the current score model, implement deterministic phrase segmentation in frontend logic:
- Primary heuristic: split on rests/gaps larger than configurable threshold in beats (e.g., `>= 0.75 beat`).
- Secondary heuristic: optional split at measure boundaries when gap exists and phrase duration exceeds a minimum.
- Output: ordered `PhraseSegment[]` containing:
  - `id`
  - `part`
  - `startBeat`
  - `endBeat`
  - `noteIndexes` / note references

This creates stable phrase windows for both live accumulation and post-phrase rendering.

### 2) Capture frame samples for analytics
Add an in-memory analysis buffer in frontend runtime:
- For every incoming pitch frame during active playback:
  - Convert frame `t` to `beat` (already available through timing helpers).
  - Resolve expected note at beat.
  - Append normalized analytic sample:
    - `tMs`, `beat`, `midi`, `conf`, `expectedMidi`, `noteId`, `deviationCents`
- Ignore frames during rests/no expected note for per-note stats, but keep optional counters for phrase voicing coverage.

### 3) Compute phrase-level summary on phrase completion
Trigger completion when playback beat crosses `phrase.endBeat`.
For each completed phrase:
- Compute weighted time-in-tolerance percentage:
  - Green range (`|cents| <= 50`) counts as in tolerance.
  - Only samples above confidence threshold included in denominator.
  - Weight each sample by `deltaMs * confidenceWeight`, where:
    - `deltaMs` = elapsed time to next frame (or median frame interval for terminal sample).
    - `confidenceWeight` = `clamp(conf / confRef, 0, 1)`.
    - `confRef` default: `0.8` (configurable constant).
- Compute per-note rollups:
  - Distribution of sample classifications (green/amber/red).
  - Mean signed cents + consistency score to infer flat/sharp tendency.
- Assign final per-note badge:
  - 🟢 majority in-tolerance
  - 🟡 mostly slight deviation
  - 🔴 significant deviation or persistent out-of-tolerance
- Attach directional marker for stable bias:
  - `flat`, `sharp`, or `neutral`.

Recommended default thresholds (single shared constants module):
- `MIN_CONFIDENCE = 0.55`
- `MIN_NOTE_SAMPLES_FOR_STRONG_BADGE = 5`
- `MIN_NOTE_SAMPLES_FOR_BIAS = 8`
- `BIAS_MEAN_CENTS_THRESHOLD = 15`
- `BIAS_CONSISTENCY_THRESHOLD = 0.7` (same-sign sample ratio)

Behavior with low sample count:
- If note samples < `MIN_NOTE_SAMPLES_FOR_STRONG_BADGE`, cap at 🟡 unless all samples are extreme outliers.
- If note samples < `MIN_NOTE_SAMPLES_FOR_BIAS`, force directional marker to `neutral`.

### 4) Add a phrase summary UI below the score
Create a dedicated panel below the score container:
- Header with phrase identifier and overall `% within tolerance`.
- Row of note badges in phrase order.
- Optional compact legend and tooltips:
  - badge color criteria
  - cents bias (e.g., “sharp +23c avg”)

Display behavior:
- Replace panel contents when a newer phrase completes.
- Keep lightweight phrase history (optional expandable list) if space permits.
- Clear summaries on score reload/part change/stop.

Suggested compact layout (ASCII wireframe):
```text
┌ Phrase 3 · 78% in tolerance ──────────────────────────────┐
│ Notes:  [C4 🟢] [D4 🟡 sharp +18c] [E4 🔴 flat -31c]      │
│ Legend: 🟢 ≤50c   🟡 51–100c   🔴 >100c                   │
└───────────────────────────────────────────────────────────┘
```

### 5) Keep overlay and summary thresholds consistent
Centralize thresholds in one shared frontend module for:
- Dot color classification.
- Summary classification.
- Flat/sharp bias detection.

This avoids drift where overlay appears green while summary marks amber/red.

### 6) Test plan
Add focused unit tests for:
- Phrase segmentation from note sequences (with/without gaps).
- Sample-to-note assignment and rest exclusion.
- Phrase aggregation math (`% in tolerance`, badge outcome, flat/sharp detection).
- Boundary handling (exact phrase end beat, low-confidence samples, empty phrases).

Add integration-level frontend test(s) for:
- Simulated frame stream crossing phrase boundary.
- Summary panel render with expected badges/text.

### 7) Acceptance-criteria mapping
- **Phrase summary appears after phrase completion**
  - phrase boundary detector + completion trigger + summary panel render.
- **Accuracy metrics are computed from pitch trace data**
  - analytics buffer + phrase aggregator from websocket frames.
- **Per-note feedback visually clear and easy to interpret**
  - badge row, legend/tooltips, consistent color semantics.

---

## Files to change

### Frontend UI/layout
1. `frontend/index.html`
   - Add summary panel container below score (and styles for phrase summary card, badge row, legend, optional bias chips).

2. `frontend/src/main.ts`
   - Wire phrase analyzer lifecycle into score load/play/pause/seek/stop flows.
   - Feed incoming pitch frames into analyzer.
   - Render latest phrase summary in new panel.
   - Reset analyzer state on score/part/transport resets.

### Frontend pitch analysis logic
3. `frontend/src/pitch/accuracy.ts`
   - Extract or extend shared threshold utilities and classification helpers for both live dots and summary computation.

4. `frontend/src/pitch/overlay.ts`
   - Reuse centralized thresholds/types (minimal refactor) to keep visual and summary classifications aligned.

5. `frontend/src/pitch/phrase-summary.ts` (**new**)
   - Phrase segmentation, sample buffering, phrase completion detection, and aggregation algorithms.
   - Export UI-ready summary DTOs.

### Frontend tests
6. `frontend/src/pitch/accuracy.test.ts`
   - Extend for any extracted/shared threshold helpers.

7. `frontend/src/pitch/overlay.test.ts`
   - Update as needed if threshold constants/types move.

8. `frontend/src/pitch/phrase-summary.test.ts` (**new**)
   - Unit tests for segmentation + aggregation + flat/sharp detection.

9. `frontend/src/main.test.ts` (**new or targeted integration test file**)
   - Validate summary rendering trigger at phrase completion with mocked frames.

---

## Non-goals for issue #80 (defer)
- Persisting phrase summaries to backend/database.
- Exporting summaries to CSV/PDF.
- Manual phrase editing UI.
- ML-based phrasing inference from lyrics/slurs.

## Risks and mitigations
- **Risk:** Phrase heuristics may feel wrong on legato music with tiny rests.
  - **Mitigation:** Keep split threshold configurable and covered by tests; expose tuning constant.
- **Risk:** Jitter near phrase end causes missed/duplicated completion events.
  - **Mitigation:** Use monotonic phrase index and single-fire completion guard.
- **Risk:** Low-confidence spans reduce sample count and produce noisy note badges.
  - **Mitigation:** Require minimum confident sample count before assigning strong red/flat/sharp labels.

## Delivery sequence (small PR slices)
1. Add `phrase-summary.ts` + tests.
2. Integrate with `main.ts` data flow and reset logic.
3. Add summary panel markup/styles in `index.html`.
4. Final consistency pass for shared thresholds and existing tests.
