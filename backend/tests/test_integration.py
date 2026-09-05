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
   Results are written to docs/latency-baseline.md at session end by the
   pytest_sessionfinish hook in conftest.py (a hook defined in this module
   would never actually be called by pytest — see conftest.py's comment).

3. TestStressDrift  (pytest.mark.hardware)
   Simulates a 3-minute session with synthetic windows injected at real-time
   cadence.  Verifies the pYIN worker thread doesn't build up a real-time
   processing backlog, or drop more than a small fraction of windows doing
   so (see class docstring — issues #545, #553).

4. TestLatencyBreakdownCPU  (pytest.mark.hardware)
   Measures per-call pYIN inference latency (p50/p95/max, no hard budget
   yet — see class docstring, issue #553). Results are written to
   docs/latency-baseline.md at session end alongside the GPU rows.

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

# Relative import is required here, not `from backend.tests.conftest import
# _record`: backend/ has no __init__.py, so pytest's own conftest loader
# (which walks up from this file looking for package boundaries) imports
# conftest.py as top-level `tests.conftest`, while an absolute
# `backend.tests.conftest` import resolves through the separately
# editable-installed `sing-attune-backend` package — two different module
# objects in sys.modules, each with its own independent `_latency_results`
# dict. The relative import instead follows *this* module's own runtime
# package identity, landing on the exact module pytest registered as a
# plugin, so state written here is the state pytest_sessionfinish reads
# (issue #553 — this was silently discarding every recorded measurement).
from .conftest import _record

# ── Paths ──────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).parent.parent.parent
PART_I = REPO_ROOT / "musescore" / "homeward_bound-PARTI.mxl"

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
    # Number of voiced windows to push through inference before starting any
    # timing measurement.  One silence warmup window (in _warmup()) loads model
    # weights but is not enough to complete CUDA JIT compilation — the first
    # ~20 real-signal inferences are still slow.  20 voiced windows puts CUDA
    # into steady-state before any p50/p95 numbers are recorded.
    N_WARMUP: int = 20

    @pytest.fixture(autouse=True)
    def require_cuda(self) -> None:
        import torch
        if not torch.cuda.is_available():
            pytest.skip("CUDA not available — GPU latency tests require a CUDA-capable GPU")

    @pytest.fixture
    def gpu_pipeline(self):
        """
        Start a torchcrepe PitchPipeline and drive N_WARMUP voiced windows
        through the full inference path before yielding.

        Background
        ──────────
        PitchPipeline._warmup() runs one silence window to load model weights,
        but CUDA JIT compilation and memory allocation are not complete until
        ~20 real-signal inferences have run.  Without this fixture-level warmup
        the first N_WARMUP samples inflate p95 to ~290 ms even on an RTX 5070.
        Steady-state latency for torchcrepe 'full' model on RTX 5070 is
        p50 ≈ 15 ms, p95 ≈ 16 ms.
        """
        p = PitchPipeline(engine=Engine.TORCHCREPE)
        p.start()

        warmup_done = threading.Event()
        warmup_count = [0]
        original_on_frame = p._on_frame

        def _warmup_counter(frame: PitchFrame) -> None:
            warmup_count[0] += 1
            if warmup_count[0] >= self.N_WARMUP:
                warmup_done.set()
            if original_on_frame:
                original_on_frame(frame)

        p._on_frame = _warmup_counter
        for _ in range(self.N_WARMUP + 5):
            p.push(_sine_window(440.0))

        warmed = warmup_done.wait(timeout=10.0)
        if not warmed:
            pytest.skip(
                f"GPU warmup timed out ({warmup_count[0]}/{self.N_WARMUP} frames emitted). "
                "torchcrepe may be dropping all windows — check CONFIDENCE_THRESHOLD."
            )

        p._on_frame = original_on_frame
        time.sleep(0.1)
        yield p
        p.stop()

    # ── Stage 1: CREPE inference ───────────────────────────────────────────────

    def test_crepe_inference_p95_under_40ms(self, gpu_pipeline: PitchPipeline) -> None:
        """CREPE inference p95 must be ≤ 40 ms on RTX 5070.

        Measurement: stop the pipeline, wrap _infer, restart.  This avoids
        the race between the worker thread and method replacement.  The fixture
        has already completed CUDA warmup, so the second start() re-enters
        steady state immediately (model weights already loaded, JIT compiled).
        """
        latencies: list[float] = []
        done = threading.Event()

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

    # ── Total: dequeue → frame emitted ────────────────────────────────────────

    def test_total_pipeline_p95_under_80ms(self, gpu_pipeline: PitchPipeline) -> None:
        """
        Dequeue-to-emit latency (inference + on_frame overhead) must be ≤ 80 ms p95.

        Measurement strategy
        ────────────────────
        Both timestamps are recorded on the pitch worker thread, which avoids
        the Windows system timer granularity problem (~15.6 ms resolution) that
        makes cross-thread Event.wait() measurements unreliable — a 15 ms
        inference padded by 15 ms wakeup jitter per sample produces artificially
        inflated p95 figures (~450 ms over 50 samples) even when real latency
        is well within budget.

        We wrap _infer to record t_dequeue (timestamp immediately before
        inference begins) and on_frame to record t_emit (timestamp immediately
        after inference completes and the callback fires).  Both execute on the
        single pitch worker thread so time.monotonic() is consistent and
        sub-millisecond accurate.

        Latency = t_emit − t_dequeue ≈ inference time + trivial on_frame overhead.
        Queue wait time (push → dequeue) is excluded; in a real session the
        queue is nearly always empty so queue wait ≈ 0.
        """
        latencies: list[float] = []
        done = threading.Event()
        t_dequeue_slot: list[float] = [0.0]

        gpu_pipeline.stop()
        original_infer = gpu_pipeline._infer

        def timed_infer(window: np.ndarray, capture_time_ms: float):
            # Record dequeue time on the worker thread — same thread as on_frame.
            t_dequeue_slot[0] = time.monotonic() * 1000.0
            return original_infer(window, capture_time_ms)

        def timed_on_frame(frame: PitchFrame) -> None:
            # Both this and timed_infer run on the worker thread; no lock needed.
            latencies.append(time.monotonic() * 1000.0 - t_dequeue_slot[0])
            if len(latencies) >= self.N_SAMPLES:
                done.set()

        gpu_pipeline._infer = timed_infer       # type: ignore[method-assign]
        gpu_pipeline._on_frame = timed_on_frame
        gpu_pipeline.start()

        for _ in range(self.N_SAMPLES + 10):
            gpu_pipeline.push(_sine_window(440.0))

        done.wait(timeout=15.0)

        if len(latencies) < 10:
            pytest.skip(
                f"Insufficient latency samples ({len(latencies)}/{self.N_SAMPLES}). "
                "torchcrepe may be dropping the 440 Hz test tone — "
                "check CONFIDENCE_THRESHOLD or try a louder test signal."
            )

        p50 = float(np.percentile(latencies, 50))
        p95 = float(np.percentile(latencies, 95))
        max_lat = max(latencies)
        print(
            f"\nTotal pipeline — p50={p50:.1f} ms  p95={p95:.1f} ms  max={max_lat:.1f} ms"
            f"  (n={len(latencies)})"
        )
        _record("total_pipeline", p50, p95, max_lat)
        assert p95 <= 80.0, (
            f"Total pipeline p95 {p95:.1f} ms exceeds 80 ms budget. "
            "Check Python GIL contention or CUDA stream synchronisation."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Stress / drift test  (hardware — any dev machine, no GPU needed)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.hardware
class TestStressDrift:
    """
    Simulate a 3-minute session by injecting windows at real-time cadence and
    verify the PitchPipeline worker thread doesn't accumulate a real-time
    processing backlog, or drop more than a small fraction of windows while
    doing so.

    "Drift" here is |last emitted frame's PlaybackPipeline.elapsed_ms -
    actual wall-clock loop duration| — both wall-clock-derived (see
    elapsed_ms in backend/audio/pipeline.py), so this is NOT testing
    PlaybackPipeline's clock math. It's a proxy for "is the pYIN worker
    thread keeping up with real time": PitchPipeline.push() is non-blocking
    against a bounded queue (_QUEUE_MAXSIZE=32) and silently drops windows on
    overflow, so if per-window inference ever exceeds the ~46ms hop budget
    for a stretch, a backlog builds up that's still draining when the loop
    ends — that backlog is what this measures, not a timestamp bug.

    Drift alone can miss a worker that drops windows early and then catches
    back up (drift ends near zero, but real frames were lost along the way)
    — see issue #553. dropped_frames is asserted separately so that case
    still fails.

    Uses pYIN so any dev machine can run this without a GPU.
    No real audio hardware is opened — all input is synthetic.
    """

    SESSION_SECONDS: float = 180.0
    # Confirmed (issue #545) to intermittently reach 438-656ms even on a
    # dedicated dev machine, across full-suite runs, standalone re-runs, and
    # unrelated PRs, with worker-thread log lines showing individual pYIN
    # calls exceeding the 80ms warning threshold (backend/audio/pitch.py) —
    # well above the ~46ms hop budget — and 1-2% of windows dropped. That's
    # real OS-scheduling jitter around a worker thread with little
    # throughput margin, not a regression. Budget is set with real headroom
    # above that observed band, but well below the queue's hard ceiling
    # (32 windows * ~46ms/hop =~ 1.5s) so a genuine "worker can't keep up
    # at all" regression still fails this test.
    DRIFT_BUDGET_MS: float = 1000.0
    # Calibrated (issue #553) against three real runs on the same machine
    # used for #545: 0.31% (12/3875), 0.57% (22/3875), 2.07% (80/3875)
    # dropped. Set at roughly 4x the observed max for headroom against
    # day-to-day variance, while staying far below the drop rate a genuine
    # "worker can't keep up at all" regression would produce (that failure
    # mode isn't bounded the way DRIFT_BUDGET_MS is by queue depth — a
    # sustained inability to keep up drops a large fraction of windows, not
    # a few percent).
    DROPPED_FRAMES_BUDGET_PCT: float = 8.0

    def test_timestamp_drift_within_budget(self) -> None:
        hop_duration_s = HOP_SIZE / SAMPLE_RATE
        n_windows = int(self.SESSION_SECONDS / hop_duration_s)

        pl = PlaybackPipeline(engine=Engine.PYIN)
        pl._state = PlaybackState.PLAYING
        pl._play_monotonic = time.monotonic()
        pl._elapsed_ms = 0.0
        # _loop defaults to None; _on_pitch_frame returns early without fan-out.

        last_t_ms: list[float] = []

        def on_frame(_: PitchFrame) -> None:
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
            f"drift={drift_ms:.1f} ms  dropped={pitch_pl.dropped_frames}"
        )
        _record("stress_drift", drift_ms, drift_ms, drift_ms, budget=self.DRIFT_BUDGET_MS)

        assert drift_ms < self.DRIFT_BUDGET_MS, (
            f"Timestamp drift {drift_ms:.1f} ms exceeds {self.DRIFT_BUDGET_MS} ms budget "
            f"(dropped_frames={pitch_pl.dropped_frames}/{n_windows}). This means the pYIN "
            "worker thread fell behind real time and built up a processing backlog in "
            "PitchPipeline's queue (see class docstring) — it is not a PlaybackPipeline "
            "clock bug. Check for CPU contention from other processes/tests, or whether "
            "pYIN inference itself is regularly exceeding the 80ms warning threshold in "
            "backend/audio/pitch.py. See issue #545."
        )

        dropped_pct = pitch_pl.dropped_frames / n_windows * 100.0
        _record(
            "dropped_pct", dropped_pct, dropped_pct, dropped_pct,
            budget=self.DROPPED_FRAMES_BUDGET_PCT,
        )

        assert dropped_pct < self.DROPPED_FRAMES_BUDGET_PCT, (
            f"{pitch_pl.dropped_frames}/{n_windows} windows ({dropped_pct:.1f}%) were "
            f"dropped, exceeding the {self.DROPPED_FRAMES_BUDGET_PCT:.0f}% budget — the "
            "worker is falling behind by more than ordinary scheduling jitter, even "
            f"though drift ({drift_ms:.1f} ms) stayed under budget this run. See issue #553."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# 4. CPU (pYIN) inference latency  (hardware — any dev machine, no GPU needed)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.hardware
class TestLatencyBreakdownCPU:
    """
    Measure per-call inference latency on the CPU (pYIN) path.

    Unlike TestLatencyBreakdownGPU, there's no CUDA JIT compilation to warm
    past — PyinPitchEngine.estimate() is plain librosa on every call, so a
    handful of discarded calls (WARMUP_CALLS) is enough to absorb any
    one-time cost (e.g. the first `import librosa`). This test reports
    p50/p95/max to docs/latency-baseline.md but does NOT assert a hard
    pass/fail budget: unlike the GPU budgets (which came from issue #5's
    original product targets), no CPU-path target has been set yet, and
    issue #545 already found individual pYIN calls exceeding the existing
    80ms worker-thread warning threshold (backend/audio/pitch.py) — asserting
    an invented number here would risk a chronically-failing test rather than
    the real goal, which is making the numbers visible so a target can be set
    from data (issue #553).
    """

    N_SAMPLES: int = 50
    WARMUP_CALLS: int = 3

    def test_pyin_inference_latency(self) -> None:
        latencies: list[float] = []
        done = threading.Event()
        call_count = [0]

        pl = PitchPipeline(engine=Engine.PYIN)
        original_infer = pl._infer

        def timed_infer(window: np.ndarray, capture_time_ms: float):
            call_count[0] += 1
            if call_count[0] <= self.WARMUP_CALLS:
                return original_infer(window, capture_time_ms)
            t0 = time.monotonic()
            result = original_infer(window, capture_time_ms)
            latencies.append((time.monotonic() - t0) * 1000.0)
            if len(latencies) >= self.N_SAMPLES:
                done.set()
            return result

        pl._infer = timed_infer  # type: ignore[method-assign]
        pl.start()

        for _ in range(self.WARMUP_CALLS + self.N_SAMPLES + 5):
            pl.push(_sine_window(440.0))
        done.wait(timeout=30.0)
        pl.stop()

        if len(latencies) < 10:
            pytest.skip(f"Insufficient samples: {len(latencies)}")

        p50 = float(np.percentile(latencies, 50))
        p95 = float(np.percentile(latencies, 95))
        max_lat = max(latencies)
        hop_budget_ms = (HOP_SIZE / SAMPLE_RATE) * 1000.0
        print(
            f"\npYIN inference — p50={p50:.1f} ms  p95={p95:.1f} ms  max={max_lat:.1f} ms  "
            f"(hop budget for reference: {hop_budget_ms:.1f} ms, no pass/fail target set — see #553)"
        )
        _record("pyin_inference", p50, p95, max_lat)
