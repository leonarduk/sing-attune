"""
backend/tests/conftest.py

Pytest configuration for sing-attune backend tests.

Markers:
  hardware — tests that require real audio hardware (mic, speakers).
             Automatically skipped in CI where no audio devices exist.
             Run locally with: uv run pytest -m hardware

  gpu      — tests that additionally require a CUDA-capable GPU.
             Automatically skipped in CI.
             Run locally with: uv run pytest -m gpu

CI detection: the GITHUB_ACTIONS environment variable is set by GitHub Actions.
"""

import datetime
import os
import sys
import types
from pathlib import Path

import pytest

from backend.audio.capture import HOP_SIZE, SAMPLE_RATE


def _ensure_sounddevice_stub() -> None:
    try:
        import sounddevice  # noqa: F401
        return
    except (ModuleNotFoundError, OSError):
        pass

    stub = types.ModuleType("sounddevice")

    class PortAudioError(Exception):
        pass

    class CallbackFlags:
        pass

    class InputStream:
        def __init__(self, *args, **kwargs):
            self.active = False

        def start(self) -> None:
            self.active = True

        def stop(self) -> None:
            self.active = False

        def close(self) -> None:
            self.active = False

    def query_hostapis() -> list[dict[str, str]]:
        return []

    def query_devices(kind=None):
        if kind == "input":
            raise PortAudioError("No input devices")
        return []

    stub.PortAudioError = PortAudioError
    stub.CallbackFlags = CallbackFlags
    stub.InputStream = InputStream
    stub.query_hostapis = query_hostapis
    stub.query_devices = query_devices
    sys.modules["sounddevice"] = stub


def _ensure_torch_stub() -> None:
    try:
        import torch  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("torch")

    class Tensor:
        pass

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def get_device_name(_index: int) -> str:
            return "CPU"

    class _NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    stub.Tensor = Tensor
    stub.cuda = _Cuda()
    stub.device = lambda name: name
    stub.no_grad = lambda: _NoGrad()
    stub.from_numpy = lambda arr: arr
    sys.modules["torch"] = stub


_ensure_sounddevice_stub()
_ensure_torch_stub()


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "hardware: mark test as requiring real audio hardware — skipped in CI",
    )
    config.addinivalue_line(
        "markers",
        "gpu: mark test as requiring a CUDA-capable GPU — skipped in CI",
    )


def pytest_collection_modifyitems(config, items):
    """Auto-skip environment-dependent tests when dependencies are unavailable."""
    import sounddevice as sd
    import torch

    skip_hardware = None
    try:
        has_input_device = bool(sd.query_devices()) and _default_input_available(sd)
    except Exception:
        has_input_device = False
    if os.environ.get("GITHUB_ACTIONS") or not has_input_device:
        skip_hardware = pytest.mark.skip(reason="hardware tests skipped (no audio devices in this environment)")

    skip_gpu = None
    if os.environ.get("GITHUB_ACTIONS") or not torch.cuda.is_available():
        skip_gpu = pytest.mark.skip(reason="gpu tests skipped (no CUDA device in this environment)")

    for item in items:
        if skip_hardware and "hardware" in item.keywords:
            item.add_marker(skip_hardware)
        if skip_gpu and "gpu" in item.keywords:
            item.add_marker(skip_gpu)


def _default_input_available(sd) -> bool:
    try:
        return sd.query_devices(kind="input") is not None
    except Exception:
        return False


# ── Latency baseline doc writer ─────────────────────────────────────────────
#
# Lives here rather than in test_integration.py because pytest only invokes
# pytest_* hooks discovered from conftest.py / registered plugins — a hook
# function defined inside a plain test module is collected as harmless dead
# code and never called. That was a real, long-standing bug (issue #553):
# docs/latency-baseline.md still held its Day-7 "not yet measured" placeholder
# after years of local hardware/GPU test runs, because pytest_sessionfinish
# had never once actually fired from its old home in test_integration.py.

REPO_ROOT = Path(__file__).parent.parent.parent
LATENCY_DOC = REPO_ROOT / "docs" / "latency-baseline.md"

_latency_results: dict[str, dict] = {}


def _record(
    key: str, p50: float, p95: float, max_val: float, budget: float | None = None
) -> None:
    """Accumulate a measurement. Written to doc at session end."""
    _latency_results[key] = {"p50": p50, "p95": p95, "max": max_val, "budget": budget}


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ARG001
    """Write docs/latency-baseline.md if any measurements were collected this run."""
    if not _latency_results:
        return

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    def _row(key: str, label: str, budget_ms: float) -> str:
        r = _latency_results.get(key)
        if r is None:
            return f"| {label} | — | — | — | ≤ {budget_ms:.0f} ms | — |"
        status = "✅" if r["p95"] <= budget_ms else "❌"
        return (
            f"| {label} | {r['p50']:.1f} ms | {r['p95']:.1f} ms | "
            f"{r['max']:.1f} ms | ≤ {budget_ms:.0f} ms | {status} |"
        )

    def _threshold_row(key: str, label: str, unit: str) -> str:
        """Render a row for a metric whose own test supplied its budget via
        _record(..., budget=...) — keeps this function decoupled from any
        specific test class (avoids importing test_integration.py here,
        which would create a circular import back to this conftest)."""
        r = _latency_results.get(key)
        if r is None:
            return f"| {label} | — | — | — | — | — |"
        budget = r.get("budget")
        if budget is None:
            budget_text, status = "—", "—"
        else:
            budget_text = f"< {budget:.0f}{unit}"
            status = "✅" if r["max"] < budget else "❌"
        return f"| {label} | — | — | {r['max']:.1f}{unit} | {budget_text} | {status} |"

    drift_row = _threshold_row("stress_drift", "Timestamp drift (3 min)", " ms")
    dropped_row = _threshold_row("dropped_pct", "Dropped windows (3 min)", "%")

    pyin = _latency_results.get("pyin_inference")
    hop_budget_ms = (HOP_SIZE / SAMPLE_RATE) * 1000.0
    if pyin:
        pyin_row = (
            f"| pYIN inference (CPU) | {pyin['p50']:.1f} ms | {pyin['p95']:.1f} ms | "
            f"{pyin['max']:.1f} ms | ~{hop_budget_ms:.1f} ms hop budget (no target set — #553) | — |"
        )
    else:
        pyin_row = (
            f"| pYIN inference (CPU) | — | — | — "
            f"| ~{hop_budget_ms:.1f} ms hop budget (no target set — #553) | — |"
        )

    doc = f"""\
# sing-attune — Latency Baseline

_Generated: {now}_

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
{_row("crepe_inference", "CREPE inference", 40)}
{_row("serialisation_queue", "Serialisation + queue", 20)}
| WebSocket frame delivery | _(see notes)_ | _(see notes)_ | _(see notes)_ | ≤ 20 ms | — |
{_row("total_pipeline", "Total (dequeue → frame emitted)", 80)}

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
{drift_row}
{dropped_row}

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
{pyin_row}

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
"""

    LATENCY_DOC.parent.mkdir(parents=True, exist_ok=True)
    LATENCY_DOC.write_text(doc, encoding="utf-8")
    # Plain ASCII: this runs at session teardown, outside pytest's normal
    # per-test output capturing, so it hits the raw Windows console encoding
    # (cp1252) directly — a ✅ here raised UnicodeEncodeError and aborted the
    # hook (issue #553), which pytest reports as an internal error even
    # though the file above had already been written successfully.
    print(f"\nLatency baseline written -> {LATENCY_DOC}")
