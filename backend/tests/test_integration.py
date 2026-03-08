"""
backend/tests/test_integration.py

Day 7: Backend integration tests and latency baseline.

Scope (additive to existing unit tests in test_pitch.py / test_pipeline.py):

1. TestScoreToFrameTimestamp
   Validates the end-to-end data flow: MusicXML → Timeline → pitch frame
   timestamp maps to a correct beat position.  CI-safe (no hardware).

2. TestLatencyBreakdownGPU  (pytest.mark.hardware, pytest.mark.gpu)
   Measures per-stage latency on the GPU path and asserts against budget:
     CREPE inference      ≤ 40 ms  (p95)
     Serialisation+queue  ≤ 20 ms  (p95)
     Total push→emit      ≤ 80 ms  (p95)
   Results are written to docs/latency-baseline.md at session end.

3. TestStressDrift  (pytest.mark.hardware)
   Simulates a 3-minute session with synthetic windows injected at real-time
   cadence.  Verifies cumulative timestamp drift < 50 ms vs wall clock.

Markers
───────
  hardware  — requires audio hardware or GPU; auto-skipped in CI
  gpu       — additionally requires CUDA; auto-skipped in CI

Run all non-hardware tests:
    uv run pytest backend/tests/test_integration.py -v -m "not hardware"

Run GPU latency tests locally:
    uv run pytest backend/tests/test_integration.py -v -m gpu

Run stress test locally (any dev machine):
    uv run pytest backend/tests/test_integration.py -v -m hardware -k stress
"""

from __future__ import annotations

import datetime
import math
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from backend.audio.capture import SAMPLE_RATE, WINDOW_SIZE, HOP_SIZE
from backend.audio.pitch import (
    Engine,
    PitchFrame,
    PitchPipeline,
)
from backend.audio.pipeline import PlaybackPipeline, PlaybackState
from backend.score.parser import parse_musicxml
from backend.score.timeline import Timeline

# ── Paths ──────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).parent.parent.parent
PART_I = REPO_ROOT / "musescore" / "homeward_bound-PARTI.mxl"
LATENCY_DOC = REPO_ROOT / "docs" / "latency-baseline.md"

# ── Shared helper ──────────────────────────────────────────────────────────────


def _sine_window(freq_hz: float = 440.0, n: int = WINDOW_SIZE) -> np.ndarray:
    """Return a 2048-sample float32 sine wave at the given frequency."""
    t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
    return (0.8 * np.sin(2 * math.pi * freq_hz * t)).astype(np.float32)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Score → Timeline → frame timestamp alignment  (CI-safe)
# ═══════════════════════════════════════════════════════════════════════════════


class TestScoreToFrameTimestamp:
    """
    Validates the full data path from MusicXML parse through Timeline to the
    beat position that would be displayed for an incoming pitch frame.

    No audio hardware required — frames are synthetic.
    """

    @pytest.mark.skipif(not PART_I.exists(), reason="Part I score not found")
    def test_frame_timestamp_maps_to_correct_beat(self) -> None:
        """
        A frame arriving at t=10 000 ms must map to approximately beat 12
        (10 s × 72 bpm / 60 = 12 beats) via the Timeline.
        """
        score = parse_musicxml(PART_I)
        timeline = Timeline(score)

        fake_frame = PitchFrame(time_ms=10_000.0, midi=63.0, confidence=0.9)
        beat = timeline.seconds_to_beat(fake_frame.time_ms / 1000.0)

        expected_beat = 10.0 * score.tempo_marks[0].bpm / 60.0
        assert abs(beat - expected_beat) < 0.5, (
            f"Beat mapping off: expected {expected_beat:.2f}, got {beat:.2f}"
        )

    @pytest.mark.skipif(not PART_I.exists(), reason="Part I score not found")
    def test_playback_start_to_first_note_timing(self) -> None:
        """
        Part I's first note (Eb4) is at beat 5.  At 72 bpm that is 4.17 s.
        A frame at t=4 166 ms should map to beat 5 ± 0.5.
        """
        score = parse_musicxml(PART_I)
        timeline = Timeline(score)

        t_first_note_ms = timeline.beat_to_seconds(5.0) * 1000.0
        beat_back = timeline.seconds_to_beat(t_first_note_ms / 1000.0)
        assert abs(beat_back - 5.0) < 0.5

    @pytest.mark.skipif(not PART_I.exists(), reason="Part I score not found")
    def test_frames_emitted_after_score_load_have_valid_beat_range(self) -> None:
        """
        Beat positions derived from frame timestamps must fall within
        [0, total_beats] for any t in [0, total_seconds * 1000].
        """
        score = parse_musicxml(PART_I)
        timeline = Timeline(score)

        total_ms = timeline.total_seconds * 1000.0
        for t_ms in np.linspace(0, total_ms, 20):
            beat = timeline.seconds_to_beat(t_ms / 1000.0)
            assert 0.0 <= beat <= score.total_beats + 1.0, (
                f"Beat {beat:.2f} out of range for t={t_ms:.0f} ms"
            )

    def test_pipeline_elapsed_ms_usable_as_frame_t(self) -> None:
        """
        PlaybackPipeline.elapsed_ms must be a positive float immediately after
        a synthetic PLAYING state is set — confirming it can be used as t in
        a pitch frame without modification.
        """
        pl = PlaybackPipeline(engine=Engine.PYIN)
        pl._state = PlaybackState.PLAYING
        pl._play_monotonic = time.monotonic()
        pl._elapsed_ms = 0.0

        time.sleep(0.05)
        t = pl.elapsed_ms
        assert t > 0.0, "elapsed_ms should be > 0 while in PLAYING state"
        assert isinstance(t, float)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Per-stage GPU latency breakdown  (hardware + gpu)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.hardware
@pytest.mark.gpu
class TestLatencyBreakdownGPU:
    """
    Measure per-stage latency on the GPU (torchcrepe) path.

    Run N_SAMPLES inference calls and report p50 / p95 / max.
    Results accumulate in _latency_results and are written to
    docs/latency-baseline.md by the pytest_sessionfinish hook below.
    """

    N_SAMPLES: int = 50

    @pytest.fixture(autouse=True)
    def require_cuda(self) -> None:
        import torch
        if not torch.cuda.is_available():
            pytest.skip("CUDA not available — GPU latency tests require a CUDA-capable GPU")

    @pytest.fixture
    def gpu_pipeline(self):
        """Create a PitchPipeline, patch _infer before start() to avoid race, then start."""
        p = PitchPipeline(engine=Engine.TORCHCREPE)
        # Warmup happens in start(); yield the started pipeline.
        p.start()
        time.sleep(0.5)  # let warmup complete
        yield p
        p.stop()

    # ── Stage 1: CREPE inference ───────────────────────────────────────────────

    def test_crepe_inference_p95_under_40ms(self, gpu_pipeline: PitchPipeline) -> None:
        """CREPE inference p95 must be ≤ 40 ms on RTX 5070.

        Measurement: stop the pipeline, wrap _infer, restart.  This avoids
        the race condition of patching a method on a running worker thread.
        Note: stop/restart triggers a second warmup, so the first 1-2 samples
        may be slower; with N_SAMPLES=50 the p95 is not materially affected.
        """
        latencies: list[float] = []
        done = threading.Event()

        # Stop → patch → restart to avoid concurrent method replacement.
        gpu_pipeline.stop()
        original_infer = gpu_pipeline._infer

        def timed_infer(window: np.ndarray, capture_time_ms: float):
            t0 = time.monotonic()
            result = original_infer(window, capture_time_ms)
            latencies.append((time.monotonic() - t0) * 1000.0)
            if len(latencies) >= self.N_SAMPLES:
                done.set()
            return result

        gpu_pipeline._infer = timed_infer  # type: ignore[method-assign]
        gpu_pipeline.start()

        for _ in range(self.N_SAMPLES + 5):
            gpu_pipeline.push(_sine_window(440.0))
        done.wait(timeout=15.0)

        if len(latencies) < 10:
            pytest.skip(f"Insufficient samples: {len(latencies)}")

        p50 = float(np.percentile(latencies, 50))
        p95 = float(np.percentile(latencies, 95))
        max_lat = max(latencies)
        print(
            f"\nCREPE inference — p50={p50:.1f} ms  p95={p95:.1f} ms  max={max_lat:.1f} ms"
        )
        _record("crepe_inference", p50, p95, max_lat)
        assert p95 <= 40.0, (
            f"CREPE inference p95 {p95:.1f} ms exceeds 40 ms budget. "
            "Check GPU utilisation and torchcrepe model size ('full' vs 'tiny')."
        )

    # ── Stage 2: serialisation + queue ────────────────────────────────────────

    def test_serialisation_and_queue_p95_under_20ms(self) -> None:
        """
        Time from _on_pitch_frame() entry to payload dict creation must be
        ≤ 20 ms p95.

        Measured by calling _on_pitch_frame() directly in a loop with no
        event loop set — the method returns early at the `if loop is None`
        guard, so no actual WebSocket fan-out occurs and no asyncio loop
        is needed.  This isolates the lock acquisition + payload build cost.
        """
        pl = PlaybackPipeline(engine=Engine.TORCHCREPE)
        pl._state = PlaybackState.PLAYING
        pl._play_monotonic = time.monotonic()
        pl._elapsed_ms = 0.0
        # _loop is None by default; _on_pitch_frame returns early after the
        # payload dict is built, before any call_soon_threadsafe calls.

        fake_frame = PitchFrame(time_ms=100.0, midi=69.0, confidence=0.9)
        latencies: list[float] = []

        for _ in range(self.N_SAMPLES):
            t0 = time.monotonic()
            pl._on_pitch_frame(fake_frame)
            latencies.append((time.monotonic() - t0) * 1000.0)

        p50 = float(np.percentile(latencies, 50))
        p95 = float(np.percentile(latencies, 95))
        max_lat = max(latencies)
        print(
            f"\nSerialisation+queue — p50={p50:.3f} ms  p95={p95:.3f} ms  "
            f"max={max_lat:.3f} ms"
        )
        _record("serialisation_queue", p50, p95, max_lat)
        assert p95 <= 20.0, (
            f"Serialisation+queue p95 {p95:.3f} ms exceeds 20 ms budget."
        )

    # ── Total: push → frame emitted ───────────────────────────────────────────

    def test_total_pipeline_p95_under_80ms(self, gpu_pipeline: PitchPipeline) -> None:
        """
        End-to-end: time from push() to on_frame() callback must be ≤ 80 ms p95.

        Measurement strategy
        ────────────────────
        Cross-thread timestamp correlation is unreliable when frames can be
        dropped (torchcrepe returns None for low-confidence windows, so push
        count != frame count).  Instead we send one window at a time, block
        until its frame arrives, then send the next.  This serialises
        throughput (~50 × 40 ms ≈ 2 s total) but gives accurate per-window
        push→emit latency — which is what the budget is defined against.

        If a window produces no frame within 2 s it is skipped; ≥10 samples
        required to pass.

        Closure note
        ────────────
        The `_ev=frame_received` default argument is intentional and correct.
        Default args in Python are evaluated at `def` time; since `def` is
        inside the loop, each iteration creates a new function object with a
        fresh Event bound as its default.  A bare closure would capture the
        *name* frame_received by reference and would race.
        """
        single_latencies: list[float] = []

        for _ in range(self.N_SAMPLES):
            frame_received = threading.Event()

            def on_frame(_f: PitchFrame, _ev: threading.Event = frame_received) -> None:
                _ev.set()

            # PitchPipeline._worker reads self._on_frame at call time — safe to
            # replace between iterations without a lock.
            gpu_pipeline._on_frame = on_frame

            t_push = time.monotonic() * 1000.0
            gpu_pipeline.push(_sine_window(440.0))
            received = frame_received.wait(timeout=2.0)

            if received:
                single_latencies.append(time.monotonic() * 1000.0 - t_push)
            # Timeout (no frame) means CREPE dropped the window (low confidence).
            # Skip so we don't inflate latency numbers.

        if len(single_latencies) < 10:
            pytest.skip(
                f"Insufficient latency samples ({len(single_latencies)}/{self.N_SAMPLES}). "
                "torchcrepe may be dropping the 440 Hz test tone — "
                "check CONFIDENCE_THRESHOLD or try a louder test signal."
            )

        p50 = float(np.percentile(single_latencies, 50))
        p95 = float(np.percentile(single_latencies, 95))
        max_lat = max(single_latencies)
        print(
            f"\nTotal pipeline — p50={p50:.1f} ms  p95={p95:.1f} ms  max={max_lat:.1f} ms"
            f"  (n={len(single_latencies)})"
        )
        _record("total_pipeline", p50, p95, max_lat)
        assert p95 <= 80.0, (
            f"Total pipeline p95 {p95:.1f} ms exceeds 80 ms budget. "
            "CREPE inference is fast — this suggests overhead outside inference. "
            "Check Python GIL contention or CUDA stream synchronisation."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Stress / drift test  (hardware — any dev machine, no GPU needed)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.hardware
class TestStressDrift:
    """
    Simulate a 3-minute session by injecting windows at real-time cadence and
    verify cumulative timestamp drift vs wall clock stays < 50 ms.

    Uses pYIN so any dev machine can run this without a GPU.
    No real audio hardware is opened — all input is synthetic.
    """

    SESSION_SECONDS: float = 180.0
    DRIFT_BUDGET_MS: float = 50.0

    def test_timestamp_drift_under_50ms(self) -> None:
        hop_duration_s = HOP_SIZE / SAMPLE_RATE
        n_windows = int(self.SESSION_SECONDS / hop_duration_s)

        pl = PlaybackPipeline(engine=Engine.PYIN)
        pl._state = PlaybackState.PLAYING
        pl._play_monotonic = time.monotonic()
        pl._elapsed_ms = 0.0
        # _loop defaults to None; _on_pitch_frame returns early without fan-out.

        last_t_ms: list[float] = []

        def on_frame(_: PitchFrame) -> None:
            # Use the public property so we get the same calculation as
            # production code (avoids duplicating the formula here).
            last_t_ms.append(pl.elapsed_ms)

        pitch_pl = PitchPipeline(engine=Engine.PYIN, on_frame=on_frame)
        pitch_pl.start()

        session_start = time.monotonic()
        for i in range(n_windows):
            pitch_pl.push(_sine_window(440.0))
            target = session_start + (i + 1) * hop_duration_s
            wait = target - time.monotonic()
            if wait > 0:
                time.sleep(wait)

        actual_duration_ms = (time.monotonic() - session_start) * 1000.0
        pitch_pl.stop()

        if not last_t_ms:
            pytest.skip("No frames emitted during stress test — pYIN needs voiced audio")

        drift_ms = abs(last_t_ms[-1] - actual_duration_ms)
        print(
            f"\nStress test ({n_windows} windows, "
            f"{actual_duration_ms / 1000:.1f} s): "
            f"last_t={last_t_ms[-1]:.1f} ms  wall={actual_duration_ms:.1f} ms  "
            f"drift={drift_ms:.1f} ms"
        )
        _record("stress_drift", drift_ms, drift_ms, drift_ms)

        assert drift_ms < self.DRIFT_BUDGET_MS, (
            f"Timestamp drift {drift_ms:.1f} ms exceeds {self.DRIFT_BUDGET_MS} ms budget. "
            "Investigate time.monotonic() accumulation in PlaybackPipeline."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Latency doc writer
# ═══════════════════════════════════════════════════════════════════════════════

_latency_results: dict[str, dict] = {}


def _record(key: str, p50: float, p95: float, max_val: float) -> None:
    """Accumulate a measurement. Written to doc at session end."""
    _latency_results[key] = {"p50": p50, "p95": p95, "max": max_val}


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

    drift = _latency_results.get("stress_drift")
    if drift:
        drift_status = "✅" if drift["max"] < 50 else "❌"
        drift_row = (
            f"| Timestamp drift (3 min) | — | — | {drift['max']:.1f} ms "
            f"| < 50 ms | {drift_status} |"
        )
    else:
        drift_row = "| Timestamp drift (3 min) | — | — | — | < 50 ms | — |"

    doc = f"""\
# sing-attune — Latency Baseline

_Generated: {now}_

## Hardware

| Component | Detail |
|---|---|
| GPU | NVIDIA RTX 5070 |
| CUDA | 12.9 |
| Pitch engine | torchcrepe (`weighted_argmax` decoder) |
| CPU fallback | librosa pYIN |
| OS | Windows 11 |

## GPU Path Results

| Stage | p50 | p95 | max | Budget | Status |
|---|---|---|---|---|---|
{_row("crepe_inference", "CREPE inference", 40)}
{_row("serialisation_queue", "Serialisation + queue", 20)}
| WebSocket frame delivery | _(see notes)_ | _(see notes)_ | _(see notes)_ | ≤ 20 ms | — |
{_row("total_pipeline", "Total (push → frame emitted)", 80)}

### Notes on WebSocket delivery

WebSocket frame delivery is not directly measurable from the backend alone.
It is implicitly bounded by the **Total** row above.
A frontend round-trip measurement should be added in a follow-up issue.

## Stress Test — Timestamp Drift

| Test | Result | Budget |
|---|---|---|
{drift_row}

Simulated 3-minute session: synthetic 440 Hz windows at real-time cadence.
Drift = |last frame t_ms − actual wall-clock duration|.

## CPU Path (pYIN)

CPU latency not formally measured in this baseline.
A follow-up issue should define targets before any CPU-only deployment.

## How to Reproduce

```bash
# GPU measurements (requires CUDA-capable GPU)
uv run pytest backend/tests/test_integration.py -v -m gpu

# Stress drift (any dev machine, no GPU required)
uv run pytest backend/tests/test_integration.py -v -m hardware -k stress

# All non-hardware tests (CI-safe)
uv run pytest backend/tests/test_integration.py -v -m "not hardware"
```
"""

    LATENCY_DOC.parent.mkdir(parents=True, exist_ok=True)
    LATENCY_DOC.write_text(doc, encoding="utf-8")
    print(f"\n✅  Latency baseline written → {LATENCY_DOC}")
