# Cross-Issue Clash Merge Plan (Issues #76, #77, #78, #79, #80)

This file merges overlapping implementation intent where multiple issues modify the same file.
Each section lists the clashing issues and a single merged scope for that file.

## `frontend/src/main.ts`
**Clashing issues:** #76, #77, #78, #79, #80

**Merged scope:**
- Keep `main.ts` as orchestration-only wiring.
- Initialize and lifecycle-manage:
  - graph canvas + synthetic feed controls (#76),
  - socket/timing synchronization hooks (#77),
  - overlay reset triggers for interpreter state (#78),
  - optional visual settings toggles for overlay behavior (#79),
  - phrase-summary pipeline and panel updates (#80).
- On score/part/transport reset, clear all pitch consumers consistently (overlay, graph buffer, phrase-summary buffer).
- Do not embed interpretation/aggregation math in `main.ts`; call dedicated pitch modules.

## `frontend/src/pitch/overlay.ts`
**Clashing issues:** #77, #78, #79, #80

**Merged scope:**
- Integrate the new interpretation layer before grading/render decisions (#78).
- Continue rendering real-time dots/trace with synchronized timing source from #77.
- Reuse centralized thresholds for color-class decisions and summary compatibility (#79, #80).
- Expose clean reset/clear hooks so `main.ts` can clear state on stop/seek/part changes.

## `frontend/src/pitch/overlay.test.ts`
**Clashing issues:** #77, #78, #79, #80

**Merged scope:**
- Cover sync-time mapping and pause/resume continuity (#77).
- Add interpretation behavior integration tests (median filtering, onset settle, hysteresis, reset) (#78).
- Verify refreshed tolerance behavior and boundary outcomes (#79).
- Ensure overlay classifications remain consistent with shared thresholds used by phrase summary (#80).

## `frontend/src/pitch/accuracy.ts`
**Clashing issues:** #76, #78, #79, #80

**Merged scope:**
- Centralize shared pitch constants/utilities (cents error, tolerance thresholds, classification helpers).
- Keep this module mostly stateless; stateful interpretation remains in `interpretation.ts` (#78).
- Provide helpers reusable by graph coloring (#76), overlay grading (#79), and phrase summary aggregation (#80).
- Maintain one canonical tolerance source to prevent overlay/summary drift.

## `frontend/src/pitch/accuracy.test.ts`
**Clashing issues:** #78, #79, #80

**Merged scope:**
- Validate threshold helpers and classification boundaries at exact edges.
- Verify extracted stateless helpers after interpretation split (#78).
- Add coverage for shared helper contracts consumed by overlay + phrase-summary (#79, #80).

## `frontend/index.html`
**Clashing issues:** #76, #79, #80

**Merged scope:**
- Add pitch graph container/controls region (#76).
- Add phrase-summary panel below score area (#80).
- Keep overlay-related controls/layout updates from #79 compatible with both new regions.
- Use a single coherent layout block so graph + score + phrase-summary coexist without duplicate wrappers.

---

## Non-clashing issue-specific files (keep independent)
- **Issue #76 only:** `frontend/src/pitch/graph.ts`, `frontend/src/pitch/graph-colors.ts`, `frontend/src/pitch/synthetic.ts`, `frontend/src/pitch/graph.test.ts`, `frontend/src/pitch/synthetic.test.ts`.
- **Issue #77 only:** `frontend/src/pitch/socket.ts`, `frontend/src/pitch/socket.test.ts`, `frontend/src/score/timing.ts`, `frontend/src/score/timing.test.ts`, `frontend/src/transport/controls.ts`.
- **Issue #78 only:** `frontend/src/pitch/interpretation.ts`, `frontend/src/pitch/interpretation.test.ts`.
- **Issue #80 only:** `frontend/src/pitch/phrase-summary.ts`, `frontend/src/pitch/phrase-summary.test.ts`.

