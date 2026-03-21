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

import time
import threading
import queue
import logging
import os
from dataclasses import dataclass
from enum import Enum, auto
from typing import Callable

from backend.models.transcription import PitchFrame

import numpy as np

try:
    import torch
except ImportError:  # pragma: no cover - exercised by thin installer runtime
    torch = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

SAMPLE_RATE: int = 22050
CONFIDENCE_THRESHOLD: float = 0.6

# torchcrepe expects 16 kHz — we resample on the fly
CREPE_SAMPLE_RATE: int = 16000

# pYIN frequency range — human singing voice
FMIN_HZ: float = 65.0    # C2
FMAX_HZ: float = 2093.0  # C7


# ── Engine selection ───────────────────────────────────────────────────────────


class Engine(Enum):
    TORCHCREPE = auto()
    PYIN = auto()


@dataclass(frozen=True)
class EngineRuntimeInfo:
    engine: Engine
    cuda: bool
    device: str
    mode: str


@dataclass(frozen=True)
class QueuedWindow:
    window: np.ndarray
    capture_time_ms: float


def resolve_engine_runtime(force_cpu: bool = False) -> EngineRuntimeInfo:
    """Resolve active engine from env + runtime override + CUDA availability."""
    env_engine = os.getenv("PITCH_ENGINE", "").strip().lower()
    env_forces_cpu = env_engine in {"aubio", "pyin", "cpu"}
    cuda_available = bool(torch and torch.cuda.is_available())

    if force_cpu or env_forces_cpu:
        reason = "runtime override" if force_cpu else "PITCH_ENGINE"
        log.info("CPU mode forced via %s — using librosa pYIN (CPU)", reason)
        return EngineRuntimeInfo(
            engine=Engine.PYIN,
            cuda=cuda_available,
            device="CPU",
            mode="forced_cpu",
        )

    if cuda_available and torch is not None:
        device_name = torch.cuda.get_device_name(0)
        log.info("CUDA available — using torchcrepe (GPU: %s)", device_name)
        return EngineRuntimeInfo(
            engine=Engine.TORCHCREPE,
            cuda=True,
            device=device_name,
            mode="auto",
        )

    log.info("No CUDA — using librosa pYIN (CPU)")
    return EngineRuntimeInfo(
        engine=Engine.PYIN,
        cuda=False,
        device="CPU",
        mode="auto",
    )


def select_engine() -> Engine:
    """
    Auto-select pitch engine based on hardware availability.
    torchcrepe on CPU is ~200ms/frame — too slow for real-time; fall back to pYIN.
    """
    return resolve_engine_runtime().engine


# ── Conversion helpers ─────────────────────────────────────────────────────────


def hz_to_midi(freq_hz: float) -> float:
    """Convert frequency in Hz to MIDI float (cent-accurate)."""
    if freq_hz <= 0:
        return 0.0
    return 12.0 * np.log2(freq_hz / 440.0) + 69.0


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
    if torch is None:
        raise RuntimeError("PyTorch is not installed. Install full-fat build for torchcrepe")

    try:
        import torchcrepe
    except ImportError:
        raise RuntimeError("torchcrepe is not installed. Run: uv pip install torchcrepe")

    import torchaudio.functional as F  # noqa: PLC0415

    audio_tensor = torch.from_numpy(window).unsqueeze(0)  # (1, N)
    audio_16k = F.resample(audio_tensor, SAMPLE_RATE, CREPE_SAMPLE_RATE).to(device)

    with torch.no_grad():
        frequency, confidence = torchcrepe.predict(
            audio_16k,
            CREPE_SAMPLE_RATE,
            hop_length=audio_16k.shape[-1],  # single frame
            fmin=FMIN_HZ,
            fmax=FMAX_HZ,
            model="full",
            decoder=torchcrepe.decode.weighted_argmax,  # avoids scipy.signal
            return_periodicity=True,
            device=device,
        )

    freq_hz = frequency[0, 0].item()
    conf = confidence[0, 0].item()

    if conf < CONFIDENCE_THRESHOLD or freq_hz <= 0:
        return None

    return PitchFrame(
        time_ms=capture_time_ms,
        midi=hz_to_midi(freq_hz),
        confidence=conf,
    )


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
    import librosa  # noqa: PLC0415

    # librosa.pyin returns (f0, voiced_flag, voiced_prob) arrays
    # hop_length = window length gives us a single frame
    f0, voiced_flag, voiced_prob = librosa.pyin(
        window,
        fmin=FMIN_HZ,
        fmax=FMAX_HZ,
        sr=SAMPLE_RATE,
        hop_length=len(window),
        frame_length=len(window),
    )

    if f0 is None or len(f0) == 0:
        return None

    freq_hz = float(f0[0]) if not np.isnan(f0[0]) else 0.0
    conf = float(voiced_prob[0]) if voiced_prob is not None else 0.0
    voiced = bool(voiced_flag[0]) if voiced_flag is not None else False

    if not voiced or conf < CONFIDENCE_THRESHOLD or freq_hz <= 0:
        return None

    return PitchFrame(
        time_ms=capture_time_ms,
        midi=hz_to_midi(freq_hz),
        confidence=conf,
    )


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
        engine: Engine | None = None,
        on_frame: Callable[[PitchFrame], None] | None = None,
    ) -> None:
        self._engine = engine or select_engine()
        if self._engine == Engine.TORCHCREPE and torch is None:
            log.warning("torchcrepe engine requested but PyTorch is unavailable; falling back to pYIN")
            self._engine = Engine.PYIN
        self._on_frame = on_frame
        self._device = "cuda" if self._engine == Engine.TORCHCREPE else "cpu"
        self._queue: queue.Queue[QueuedWindow | None] = queue.Queue(
            maxsize=self._QUEUE_MAXSIZE
        )
        self._thread: threading.Thread | None = None
        self._running = False
        self._dropped_frames = 0

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
                if frame is not None and self._on_frame:
                    self._on_frame(frame)
            except Exception:
                log.exception("Pitch inference error")

    def _infer(self, window: np.ndarray, capture_time_ms: float) -> PitchFrame | None:
        if self._engine == Engine.TORCHCREPE:
            return _infer_torchcrepe(window, self._device, capture_time_ms)
        return _infer_pyin(window, capture_time_ms)

    def _warmup(self) -> None:
        try:
            silence = np.zeros(2048, dtype=np.float32)
            self._infer(silence, 0.0)
            log.info("PitchPipeline warmup complete")
        except Exception:
            log.exception("PitchPipeline warmup failed (non-fatal)")
