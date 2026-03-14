# Three PR Prompts to Split `/issues` Work with Minimal Merge Conflicts

Use these prompts in order. Each prompt is scoped so shared files are touched once in a controlled way.

## Prompt 1 — PR: `main.ts` orchestration seams (refactor-only)

```text
You are working in /workspace/sing-attune.

Goal:
Create a refactor-only PR that reduces future merge conflicts by making frontend/src/main.ts orchestration-only. Do NOT change user-visible behavior.

Scope:
- Touch ONLY wiring/orchestration code paths.
- Extract feature wiring from frontend/src/main.ts into small integration helpers/modules (for example: overlay lifecycle, socket lifecycle, reset hooks).
- Keep all feature math/aggregation out of main.ts.
- Keep runtime behavior unchanged.

Required outcomes:
1) frontend/src/main.ts becomes a thin coordinator with clear init/start/stop/reset flow.
2) Reset semantics are centralized and explicit so all pitch consumers can be reset from one place.
3) Existing tests pass; add/adjust tests only for refactor safety.

Constraints:
- No new feature flags.
- No UI/layout changes.
- No threshold logic changes.
- Avoid broad renames unrelated to extraction.

Validation:
- Run frontend tests.
- Run typecheck/lint if available.

Deliverables:
- Small, reviewable commit set.
- PR title suggestion: "refactor(frontend): split main.ts into orchestration seams"
- PR body with: motivation, moved responsibilities, and proof of no behavior change.
```

## Prompt 2 — PR: shared pitch classification contract

```text
You are working in /workspace/sing-attune.

Goal:
Create a PR that centralizes pitch classification/tolerance rules so overlay and phrase-summary logic cannot drift.

Scope:
- Update frontend/src/pitch/accuracy.ts to be the canonical source for shared thresholds/utilities.
- Update frontend/src/pitch/overlay.ts (and related tests) to consume shared helpers/constants from accuracy.ts.
- Keep interpretation state in interpretation.ts (if present); keep accuracy helpers mostly stateless.

Required outcomes:
1) One canonical threshold contract used by both live overlay classification and summary-oriented consumers.
2) Boundary behavior is covered in tests (exact edges for green/amber/red or equivalent classes).
3) No duplicate threshold constants left in overlay-specific code.

Constraints:
- No large UI rewrites.
- No unrelated transport/socket refactors.

Validation:
- Run accuracy + overlay tests.
- Run full frontend test suite if feasible.

Deliverables:
- PR title suggestion: "refactor(pitch): unify overlay and summary tolerance thresholds"
- PR body with: contract definition, migrated callsites, and boundary test evidence.
```

## Prompt 3 — PR: phrase-summary feature + layout integration

```text
You are working in /workspace/sing-attune.

Goal:
Implement the phrase-summary feature cleanly on top of the refactor seam PR and shared-threshold PR.

Scope:
- Add phrase segmentation + aggregation module (new frontend/src/pitch/phrase-summary.ts and tests).
- Add/adjust layout container in frontend/index.html for phrase summary display.
- Wire runtime integration in frontend/src/main.ts using orchestration hooks from the seam refactor.
- Ensure reset behavior clears phrase-summary state on score/part/transport resets.

Required outcomes:
1) Phrase summary appears when a phrase completes.
2) Summary metrics are computed from incoming pitch frames.
3) Per-note feedback is readable and consistent with shared threshold colors.

Constraints:
- Reuse canonical thresholds from accuracy.ts.
- Keep main.ts orchestration-only (no aggregation math in main.ts).

Validation:
- Add unit tests for segmentation + aggregation + low-sample behavior.
- Add integration test(s) for phrase completion rendering trigger.
- Run frontend test suite.

Deliverables:
- PR title suggestion: "feat(pitch): add phrase summary panel and aggregation pipeline"
- Include screenshot of the new summary panel in the PR.
- PR body with acceptance-criteria mapping.
```

## Suggested branch/merge order

1. `refactor/main-orchestration-seams`
2. `refactor/shared-pitch-threshold-contract`
3. `feat/phrase-summary-panel`

Merge in this order to minimize conflicts in `frontend/src/main.ts`.
