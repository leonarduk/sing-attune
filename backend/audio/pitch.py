"""
backend/audio/pitch.py

Real-time pitch detection pipeline.

Primary engine:  torchcrepe (PyTorch + CUDA) — RTX 5070, ~5-15ms inference
CPU fallback:    librosa pYIN — ships with torchcrepe, no extra install needed

Output per frame:
    {"time_ms": float, "midi": float, "confidence": float}

Frames below CONFIDENCE_THRESHOLD are dropped, not emitted.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from backend.models.transcription import PitchFrame

from .engine import (
    CONFIDENCE_THRESHOLD,  # noqa: F401 -- public compatibility export
    CREPE_SAMPLE_RATE,  # noqa: F401 -- public compatibility export
    FMAX_HZ,  # noqa: F401 -- public compatibility export
    FMIN_HZ,  # noqa: F401 -- public compatibility export
    SAMPLE_RATE,  # noqa: F401 -- public compatibility export
    Engine,
    EngineRuntimeInfo,  # noqa: F401 -- public compatibility export
    PitchEngine,
    PyinPitchEngine,
    TorchCrepePitchEngine,
    create_pitch_engine,
    hz_to_midi,  # noqa: F401 -- public compatibility export
    resolve_engine_runtime,  # noqa: F401 -- public compatibility export
    select_engine,  # noqa: F401 -- public compatibility export
)

log = logging.getLogger(__name__)

# Consecutive torchcrepe inference failures (CUDA context lost, VRAM
# exhausted, driver reset, ...) before PitchPipeline gives up on the GPU
# engine and asks its owner to fall back to CPU (pyin). Once torchcrepe
# starts raising mid-session it typically fails on every subsequent frame
# with nothing client-visible (the WS keepalive ping keeps ticking), so we
# can't just log-and-continue like a normal per-frame miss -- see issue #427.
# Windows push a new frame roughly every HOP_SIZE/SAMPLE_RATE ~= 46ms
# (backend/audio/capture.py), so 3 tolerates a single transient hiccup
# while still reacting within ~140ms -- short enough that the singer isn't
# staring at a dead pipeline for long, long enough not to flap on noise.
_MAX_CONSECUTIVE_TORCHCREPE_FAILURES: int = 3

# ── Engine selection ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class QueuedWindow:
    window: np.ndarray
    capture_time_ms: float


# ── Conversion helpers ─────────────────────────────────────────────────────────


def midi_to_hz(midi: float) -> float:
    """Convert MIDI float to frequency in Hz."""
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


# ── torchcrepe engine ──────────────────────────────────────────────────────────


def _infer_torchcrepe(
    window: np.ndarray,
    device,
    capture_time_ms: float,
) -> PitchFrame | None:
    """
    Run torchcrepe inference on a single 2048-sample window.

    Uses weighted_argmax decoder to avoid the scipy.signal dependency
    that Viterbi requires (blocked by Application Control on some machines).
    Returns None if confidence < threshold or no pitch detected.
    """
    return TorchCrepePitchEngine(device=device).estimate(window, capture_time_ms)


# ── librosa pYIN engine ────────────────────────────────────────────────────────


def _infer_pyin(
    window: np.ndarray,
    capture_time_ms: float,
) -> PitchFrame | None:
    """
    Run librosa pYIN on a single window.
    librosa is already installed as a torchcrepe dependency — no extra install.
    Returns None if no pitch detected above threshold.
    """
    return PyinPitchEngine().estimate(window, capture_time_ms)


# ── Pipeline ───────────────────────────────────────────────────────────────────


class PitchPipeline:
    """
    Receives audio windows from MicCapture's ring buffer and runs pitch
    detection in a dedicated worker thread.

    Usage:
        pipeline = PitchPipeline(on_frame=my_callback)
        pipeline.start()
        cap = MicCapture(on_window=pipeline.push)
        cap.start()
        ...
        cap.stop()
        pipeline.stop()

    The on_frame callback fires from the worker thread — keep it fast.
    """

    _QUEUE_MAXSIZE: int = 32

    def __init__(
        self,
        engine: Engine | PitchEngine | None = None,
        on_frame: Callable[[PitchFrame], None] | None = None,
        on_engine_failure: Callable[[], None] | None = None,
    ) -> None:
        self._pitch_engine = (
            create_pitch_engine(engine) if isinstance(engine, Engine) or engine is None else engine
        )
        self._engine = self._pitch_engine.kind
        self._on_frame = on_frame
        # Called at most once per instance, from the worker thread, after
        # _MAX_CONSECUTIVE_TORCHCREPE_FAILURES back-to-back GPU inference
        # errors. Owners (e.g. PlaybackPipeline) use this to trigger their
        # own CPU-fallback switch — see _handle_inference_failure().
        self._on_engine_failure = on_engine_failure
        self._device = self._pitch_engine.device
        self._queue: queue.Queue[QueuedWindow | None] = queue.Queue(
            maxsize=self._QUEUE_MAXSIZE
        )
        self._thread: threading.Thread | None = None
        self._running = False
        self._dropped_frames = 0
        self._consecutive_failures = 0
        self._fallback_notified = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True, name="pitch-worker")
        self._thread.start()
        log.info("PitchPipeline started — engine=%s device=%s", self._engine.name, self._device)

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        self._queue.put(None)  # sentinel
        if self._thread:
            self._thread.join(timeout=2.0)
        log.info("PitchPipeline stopped (dropped frames: %d)", self._dropped_frames)

    def push(self, window: np.ndarray, capture_time_ms: float | None = None) -> None:
        """Non-blocking: drops window if worker is falling behind."""
        queued_window = QueuedWindow(
            window=window,
            capture_time_ms=(
                time.monotonic() * 1000.0 if capture_time_ms is None else capture_time_ms
            ),
        )
        try:
            self._queue.put_nowait(queued_window)
        except queue.Full:
            self._dropped_frames += 1

    @property
    def engine(self) -> Engine:
        return self._engine

    @property
    def device(self) -> str:
        return self._device

    @property
    def dropped_frames(self) -> int:
        return self._dropped_frames

    @property
    def consecutive_failures(self) -> int:
        """
        Mutated only on the pitch worker thread (see _worker()); no lock.
        Safe to read after stop() has joined the thread (as tests do), or
        for best-effort/advisory observability while running — like
        dropped_frames, it is not synchronized for concurrent reads.
        """
        return self._consecutive_failures

    def _worker(self) -> None:
        self._warmup()
        while True:
            queued_window = self._queue.get()
            if queued_window is None:
                break
            try:
                t0 = time.monotonic()
                frame = self._infer(
                    queued_window.window,
                    queued_window.capture_time_ms,
                )
                elapsed_ms = (time.monotonic() - t0) * 1000.0
                if elapsed_ms > 80.0:
                    log.warning("Inference took %.1f ms (target <80ms)", elapsed_ms)
                # A successful call (even one that returns None, e.g. below
                # confidence threshold) clears the streak — only back-to-back
                # *exceptions* indicate a broken GPU engine, not a quiet voice.
                self._consecutive_failures = 0
                if frame is not None and self._on_frame:
                    self._on_frame(frame)
            except Exception:
                log.exception("Pitch inference error")
                self._handle_inference_failure()

    def _handle_inference_failure(self) -> None:
        """
        Count consecutive inference exceptions and, once the GPU engine has
        failed _MAX_CONSECUTIVE_TORCHCREPE_FAILURES times in a row, notify
        the owner exactly once so it can fall back to CPU (issue #427).

        Scoped to the torchcrepe engine only: a lost CUDA context / OOM
        recurs on every subsequent frame with no self-recovery, whereas
        pyin failures are handled independently (issue #426) and shouldn't
        trip this GPU-specific circuit breaker.
        """
        if self._engine != Engine.TORCHCREPE:
            return
        self._consecutive_failures += 1
        if self._consecutive_failures < _MAX_CONSECUTIVE_TORCHCREPE_FAILURES:
            return
        if self._fallback_notified:
            return
        self._fallback_notified = True
        log.error(
            "torchcrepe failed %d times consecutively — notifying owner to fall back to CPU engine",
            self._consecutive_failures,
        )
        if self._on_engine_failure:
            self._on_engine_failure()

    def _infer(self, window: np.ndarray, capture_time_ms: float) -> PitchFrame | None:
        return self._pitch_engine.estimate(window, capture_time_ms)

    def _warmup(self) -> None:
        try:
            silence = np.zeros(2048, dtype=np.float32)
            self._infer(silence, 0.0)
            log.info("PitchPipeline warmup complete")
        except Exception:
            log.exception("PitchPipeline warmup failed (non-fatal)")
