# sing-attune — Latency Baseline

_Generated: 2026-09-04 06:05_

## Hardware

| Component | Detail |
|---|---|
| GPU | NVIDIA RTX 5070 |
| CUDA | 12.9 |
| Pitch engine | torchcrepe (`weighted_argmax` decoder, `full` model) |
| CPU fallback | librosa pYIN |
| OS | Windows 11 |

## GPU Path Results

| Stage | p50 | p95 | max | Budget | Status |
|---|---|---|---|---|---|
| CREPE inference | — | — | — | ≤ 40 ms | — |
| Serialisation + queue | — | — | — | ≤ 20 ms | — |
| WebSocket frame delivery | _(see notes)_ | _(see notes)_ | _(see notes)_ | ≤ 20 ms | — |
| Total (dequeue → frame emitted) | — | — | — | ≤ 80 ms | — |

### Notes on WebSocket delivery

WebSocket frame delivery is not directly measurable from the backend alone.
It is implicitly bounded by the **Total** row above.
A frontend round-trip measurement should be added in a follow-up issue.

### Notes on warmup and measurement methodology

torchcrepe CUDA JIT compilation takes ~20 inferences to reach steady state.
All measurements exclude the warmup phase.
Cold-start latency is ~290 ms p95 — expected, not a concern for sustained use.

The Total stage measures dequeue→emit on the worker thread rather than
push→wakeup across threads. Cross-thread Event.wait() on Windows has ~15.6 ms
timer resolution, which inflates p95 by ~450 ms over 50 samples even when
actual inference is 15 ms. Both timestamps are taken on the same thread
(time.monotonic()) so measurement error is sub-millisecond.

## Stress Test — Timestamp Drift

| Stage | p50 | p95 | max | Budget | Status |
|---|---|---|---|---|---|
| Timestamp drift (3 min) | — | — | 16.0 ms | < 1000 ms | ✅ |
| Dropped windows (3 min) | — | — | 0.6% | < 8% | ✅ |

Simulated 3-minute session: synthetic 440 Hz windows at real-time cadence.
Drift = |last frame t_ms − actual wall-clock duration|. This is a proxy for
pYIN worker-thread backlog (PitchPipeline's queue is bounded and drops
frames rather than blocking), not PlaybackPipeline clock accuracy — see
TestStressDrift's docstring and issue #545 for the full analysis. Dropped
windows is the more direct signal for "is the worker keeping up" (see #553);
both are asserted on independently.

## CPU Path (pYIN)

| Stage | p50 | p95 | max | Budget | Status |
|---|---|---|---|---|---|
| pYIN inference (CPU) | 31.0 ms | 32.0 ms | 32.0 ms | ~46.4 ms hop budget (no target set — #553) | — |

No pass/fail target is asserted yet — see TestLatencyBreakdownCPU's
docstring and issue #553. The hop budget column is shown for context only
(the rate windows actually arrive at in real-time streaming), not a
committed product target.

## How to Reproduce

```bash
# GPU measurements (requires CUDA-capable GPU)
uv run pytest backend/tests/test_integration.py -v -m gpu -s

# Stress drift (any dev machine, no GPU required)
uv run pytest backend/tests/test_integration.py -v -m hardware -k stress -s

# All non-hardware tests (CI-safe)
uv run pytest backend/tests/test_integration.py -v -m "not hardware"
```
