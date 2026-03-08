# sing-attune — Latency Baseline

_Status: awaiting first local GPU measurement run_

This document tracks measured latency for the pitch detection pipeline on the
target development machine.  It is updated automatically by the integration
test suite — do not edit the Results section by hand.

To populate this document with real numbers, run on the RTX 5070 machine:

```bash
uv run pytest backend/tests/test_integration.py -v -m gpu
```

The test session will overwrite this file with measured values.

---

## Hardware

| Component | Detail |
|---|---|
| GPU | NVIDIA RTX 5070 |
| CUDA | 12.9 |
| Pitch engine | torchcrepe (`weighted_argmax` decoder) |
| CPU fallback | librosa pYIN |
| OS | Windows 11 |

## GPU Path Results

_Not yet measured.  Run the GPU tests locally to populate._

| Stage | p50 | p95 | max | Budget | Status |
|---|---|---|---|---|---|
| CREPE inference | — | — | — | ≤ 40 ms | — |
| Serialisation + queue | — | — | — | ≤ 20 ms | — |
| WebSocket frame delivery | _(see notes)_ | _(see notes)_ | _(see notes)_ | ≤ 20 ms | — |
| Total (push → frame emitted) | — | — | — | ≤ 80 ms | — |

### Notes on WebSocket delivery

WebSocket frame delivery latency is dominated by the OS network stack and is
not directly measurable from the backend alone.  It is implicitly captured in
the **Total** row above (push → frame emitted includes queue delivery).
A separate frontend measurement (round-trip via echo WS) should be added in
a follow-up issue.

## Stress Test — Timestamp Drift

_Not yet measured._

| Test | Result | Budget |
|---|---|---|
| Timestamp drift (3 min) | — | < 50 ms |

A 3-minute session of synthetic 440 Hz windows injected at real-time cadence.
Drift is the absolute difference between `PlaybackPipeline.elapsed_ms` at the
last emitted frame and the actual wall-clock duration of the test.

## CPU Path (pYIN)

CPU path latency has not been formally measured in this baseline.  A follow-up
issue should establish a target before any deployment scenario that may not
have a CUDA GPU is considered.

## How to Reproduce

```bash
# GPU measurements (requires RTX 5070 or CUDA-capable GPU)
uv run pytest backend/tests/test_integration.py -v -m gpu

# Stress drift (any dev machine, no GPU required)
uv run pytest backend/tests/test_integration.py -v -m hardware -k stress

# All non-hardware tests (CI-safe)
uv run pytest backend/tests/test_integration.py -v -m "not hardware"
```
