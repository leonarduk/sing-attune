"""Pluggable pitch-engine implementations and runtime selection."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import Enum, auto
from typing import Protocol, runtime_checkable

import numpy as np

from backend.models.transcription import PitchFrame

try:
    import torch
except ImportError:  # pragma: no cover - exercised by thin installer runtime
    torch = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

SAMPLE_RATE: int = 22050
CONFIDENCE_THRESHOLD: float = 0.6
CREPE_SAMPLE_RATE: int = 16000
FMIN_HZ: float = 65.0
FMAX_HZ: float = 2093.0


class Engine(Enum):
    TORCHCREPE = auto()
    PYIN = auto()


@dataclass(frozen=True)
class EngineRuntimeInfo:
    engine: Engine
    cuda: bool
    device: str
    mode: str


@runtime_checkable
class PitchEngine(Protocol):
    """Minimal boundary implemented by every frame-level pitch estimator."""

    kind: Engine
    device: str

    def estimate(
        self, window: np.ndarray, capture_time_ms: float
    ) -> PitchFrame | None:
        """Estimate the pitch in one audio window."""
        ...


def hz_to_midi(freq_hz: float) -> float:
    """Convert frequency in Hz to MIDI float (cent-accurate)."""
    if freq_hz <= 0:
        return 0.0
    return 12.0 * np.log2(freq_hz / 440.0) + 69.0


class TorchCrepePitchEngine:
    """GPU-backed torchcrepe estimator."""

    kind = Engine.TORCHCREPE

    def __init__(self, device: str = "cuda") -> None:
        if torch is None:
            raise RuntimeError(
                "PyTorch is not installed. Install full-fat build for torchcrepe"
            )
        self.device = device

    def estimate(
        self, window: np.ndarray, capture_time_ms: float
    ) -> PitchFrame | None:
        try:
            import torchcrepe
        except ImportError:
            raise RuntimeError(
                "torchcrepe is not installed. Run: uv pip install torchcrepe"
            ) from None

        from torchaudio import functional

        audio_tensor = torch.from_numpy(window).unsqueeze(0)
        audio_16k = functional.resample(
            audio_tensor, SAMPLE_RATE, CREPE_SAMPLE_RATE
        ).to(self.device)

        with torch.no_grad():
            frequency, confidence = torchcrepe.predict(
                audio_16k,
                CREPE_SAMPLE_RATE,
                hop_length=audio_16k.shape[-1],
                fmin=FMIN_HZ,
                fmax=FMAX_HZ,
                model="full",
                # Viterbi pulls in scipy.signal, which is blocked by Application
                # Control on supported Windows installations.
                decoder=torchcrepe.decode.weighted_argmax,
                return_periodicity=True,
                device=self.device,
            )

        freq_hz = frequency[0, 0].item()
        confidence_value = confidence[0, 0].item()
        if confidence_value < CONFIDENCE_THRESHOLD or freq_hz <= 0:
            return None
        return PitchFrame(
            time_ms=capture_time_ms,
            midi=hz_to_midi(freq_hz),
            confidence=confidence_value,
        )


class PyinPitchEngine:
    """CPU-backed librosa pYIN estimator."""

    kind = Engine.PYIN
    device = "cpu"

    def estimate(
        self, window: np.ndarray, capture_time_ms: float
    ) -> PitchFrame | None:
        import librosa

        # center=False: hop_length == frame_length == len(window) is meant to
        # yield exactly one frame per call. librosa's default center=True pads
        # the signal instead, which turns that into 2 frames — f0[0] ends up
        # centered on sample 0, so roughly half of its analysis window is
        # padding rather than real audio, degrading pitch/confidence accuracy
        # on every window. Matches the offline path in pitch_track.py. #426
        f0, voiced_flag, voiced_prob = librosa.pyin(
            window,
            fmin=FMIN_HZ,
            fmax=FMAX_HZ,
            sr=SAMPLE_RATE,
            hop_length=len(window),
            frame_length=len(window),
            center=False,
        )
        if f0 is None or len(f0) == 0:
            return None

        freq_hz = float(f0[0]) if not np.isnan(f0[0]) else 0.0
        confidence_value = float(voiced_prob[0]) if voiced_prob is not None else 0.0
        voiced = bool(voiced_flag[0]) if voiced_flag is not None else False
        if not voiced or confidence_value < CONFIDENCE_THRESHOLD or freq_hz <= 0:
            return None
        return PitchFrame(
            time_ms=capture_time_ms,
            midi=hz_to_midi(freq_hz),
            confidence=confidence_value,
        )


def resolve_engine_runtime(force_cpu: bool = False) -> EngineRuntimeInfo:
    """Resolve active engine from env + runtime override + CUDA availability."""
    env_engine = os.getenv("PITCH_ENGINE", "").strip().lower()
    env_forces_cpu = env_engine in {"aubio", "pyin", "cpu"}
    cuda_available = bool(torch and torch.cuda.is_available())

    if force_cpu or env_forces_cpu:
        reason = "runtime override" if force_cpu else "PITCH_ENGINE"
        log.info("CPU mode forced via %s — using librosa pYIN (CPU)", reason)
        return EngineRuntimeInfo(Engine.PYIN, cuda_available, "CPU", "forced_cpu")
    if cuda_available and torch is not None:
        device_name = torch.cuda.get_device_name(0)
        log.info("CUDA available — using torchcrepe (GPU: %s)", device_name)
        return EngineRuntimeInfo(Engine.TORCHCREPE, True, device_name, "auto")
    log.info("No CUDA — using librosa pYIN (CPU)")
    return EngineRuntimeInfo(Engine.PYIN, False, "CPU", "auto")


def create_pitch_engine(
    engine: Engine | None = None, *, force_cpu: bool = False
) -> PitchEngine:
    """Create the selected pitch engine behind the common interface."""
    selected = engine or resolve_engine_runtime(force_cpu=force_cpu).engine
    if selected is Engine.TORCHCREPE:
        if torch is None:
            log.warning(
                "torchcrepe engine requested but PyTorch is unavailable; falling back to pYIN"
            )
            return PyinPitchEngine()
        return TorchCrepePitchEngine()
    return PyinPitchEngine()


def select_engine() -> Engine:
    """Return the automatically selected engine kind."""
    return resolve_engine_runtime().engine
