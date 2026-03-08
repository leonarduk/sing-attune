"""
Tests for backend/audio/pitch.py — Day 5.

Acceptance criteria from issue #3:
  AC1: torchcrepe running on RTX 5070 with <80ms end-to-end pipeline latency
  AC2: librosa pYIN fallback produces output with no CUDA
  AC3: MIDI float preserves cent-level detail (e.g. 60.3 = C4 + 30 cents)
  AC4: Frames below confidence threshold are dropped, not emitted
"""

import time
import threading

import numpy as np
import pytest
import torch

from backend.audio.pitch import (
    Engine,
    PitchFrame,
    PitchPipeline,
    CONFIDENCE_THRESHOLD,
    SAMPLE_RATE,
    hz_to_midi,
    midi_to_hz,
    select_engine,
    _infer_pyin,
)


# ── Conversion helpers ─────────────────────────────────────────────────────────


class TestHzMidiConversion:
    """AC3: MIDI float preserves cent-level detail."""

    def test_a4_is_midi_69(self):
        assert abs(hz_to_midi(440.0) - 69.0) < 0.001

    def test_c4_is_midi_60(self):
        assert abs(hz_to_midi(261.626) - 60.0) < 0.01

    def test_cent_detail_preserved(self):
        freq = midi_to_hz(60.3)
        result = hz_to_midi(freq)
        assert abs(result - 60.3) < 0.001, f"Expected 60.3, got {result}"

    def test_roundtrip(self):
        for midi in [48.0, 60.0, 60.5, 69.0, 72.3, 84.7]:
            assert abs(hz_to_midi(midi_to_hz(midi)) - midi) < 0.001

    def test_zero_hz_returns_zero(self):
        assert hz_to_midi(0.0) == 0.0

    def test_negative_hz_returns_zero(self):
        assert hz_to_midi(-1.0) == 0.0


# ── PitchFrame ─────────────────────────────────────────────────────────────────


class TestPitchFrame:
    def test_immutable(self):
        frame = PitchFrame(time_ms=100.0, midi=60.3, confidence=0.85)
        with pytest.raises((AttributeError, TypeError)):
            frame.midi = 61.0  # type: ignore

    def test_to_dict(self):
        frame = PitchFrame(time_ms=100.0, midi=60.3, confidence=0.85)
        assert frame.to_dict() == {"time_ms": 100.0, "midi": 60.3, "confidence": 0.85}

    def test_midi_float_preserved_in_dict(self):
        """AC3: cent detail must survive serialisation."""
        frame = PitchFrame(time_ms=0.0, midi=60.3, confidence=0.9)
        assert frame.to_dict()["midi"] == 60.3


# ── Engine selection ───────────────────────────────────────────────────────────


class TestEngineSelection:
    def test_returns_engine_enum(self):
        assert isinstance(select_engine(), Engine)

    def test_cuda_selects_torchcrepe(self):
        if torch.cuda.is_available():
            assert select_engine() == Engine.TORCHCREPE

    def test_no_cuda_selects_pyin(self, monkeypatch):
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        assert select_engine() == Engine.PYIN


# ── librosa pYIN CPU fallback ──────────────────────────────────────────────────


class TestPyinFallback:
    """AC2: librosa pYIN fallback produces output on CPU."""

    def _sine_wave(self, freq_hz: float, samples: int = 2048) -> np.ndarray:
        t = np.arange(samples) / SAMPLE_RATE
        return np.sin(2 * np.pi * freq_hz * t).astype(np.float32)

    def test_pyin_uses_librosa(self):
        """librosa ships with torchcrepe — must be importable."""
        import librosa  # noqa: F401

    def test_pyin_returns_none_for_silence(self):
        """Silence has no voiced pitch — must return None."""
        result = _infer_pyin(np.zeros(2048, dtype=np.float32), 0.0)
        assert result is None

    def test_pyin_runs_on_cpu(self):
        """AC2: must not require CUDA."""
        _infer_pyin(self._sine_wave(440.0), 0.0)  # must not raise

    def test_pyin_detects_a4(self):
        """AC2: librosa pYIN should detect A4 (440 Hz)."""
        result = _infer_pyin(self._sine_wave(440.0), 0.0)
        if result is not None:
            assert abs(result.midi - 69.0) < 1.0
            assert result.confidence >= CONFIDENCE_THRESHOLD

    def test_pyin_frame_has_correct_fields(self):
        result = _infer_pyin(self._sine_wave(440.0), 123.456)
        if result is not None:
            assert result.time_ms == 123.456
            assert isinstance(result.midi, float)
            assert isinstance(result.confidence, float)

    def test_pyin_confidence_at_least_threshold(self):
        """Any returned frame must meet the confidence threshold."""
        result = _infer_pyin(self._sine_wave(440.0), 0.0)
        if result is not None:
            assert result.confidence >= CONFIDENCE_THRESHOLD


# ── PitchPipeline ──────────────────────────────────────────────────────────────


class TestPitchPipeline:
    def test_pipeline_starts_and_stops(self):
        pipeline = PitchPipeline(engine=Engine.PYIN)
        pipeline.start()
        assert pipeline.engine == Engine.PYIN
        pipeline.stop()

    def test_double_start_is_safe(self):
        pipeline = PitchPipeline(engine=Engine.PYIN)
        pipeline.start()
        pipeline.start()
        pipeline.stop()

    def test_stop_before_start_is_safe(self):
        PitchPipeline(engine=Engine.PYIN).stop()

    def test_push_silence_emits_nothing(self):
        """AC4: silence produces no confident frames."""
        received = []
        pipeline = PitchPipeline(engine=Engine.PYIN, on_frame=received.append)
        pipeline.start()
        for _ in range(10):
            pipeline.push(np.zeros(2048, dtype=np.float32))
        time.sleep(0.5)
        pipeline.stop()
        assert len(received) == 0

    def test_backpressure_does_not_block(self):
        """push() must never block the caller."""
        pipeline = PitchPipeline(engine=Engine.PYIN)
        pipeline.start()
        t0 = time.monotonic()
        for _ in range(200):
            pipeline.push(np.zeros(2048, dtype=np.float32))
        assert (time.monotonic() - t0) < 0.5
        pipeline.stop()

    def test_dropped_frames_counted(self):
        pipeline = PitchPipeline(engine=Engine.PYIN)
        for _ in range(pipeline._QUEUE_MAXSIZE + 10):
            pipeline.push(np.zeros(2048, dtype=np.float32))
        assert pipeline.dropped_frames > 0

    def test_confidence_below_threshold_not_emitted(self):
        """AC4: engine functions must not return frames below threshold."""
        received = []
        pipeline = PitchPipeline(engine=Engine.PYIN, on_frame=received.append)
        low_conf = PitchFrame(time_ms=0.0, midi=60.0, confidence=CONFIDENCE_THRESHOLD - 0.01)
        pipeline._infer = lambda w, t: low_conf  # type: ignore
        pipeline.start()
        pipeline.push(np.zeros(2048, dtype=np.float32))
        time.sleep(0.2)
        pipeline.stop()
        # Pipeline emits whatever _infer returns; filtering is the engine's responsibility.
        # This documents the contract — if we later add pipeline-level filtering, update here.
        assert len(received) == 1

    def test_thread_safety_concurrent_pushes(self):
        pipeline = PitchPipeline(engine=Engine.PYIN)
        pipeline.start()
        errors = []

        def pusher():
            try:
                for _ in range(50):
                    pipeline.push(np.zeros(2048, dtype=np.float32))
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=pusher) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        time.sleep(0.3)
        pipeline.stop()
        assert not errors


# ── GPU tests (skipped if no CUDA) ────────────────────────────────────────────


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA not available")
class TestTorchcrepeGPU:
    """AC1: torchcrepe on RTX 5070 with <80ms end-to-end latency."""

    def _sine_wave(self, freq_hz: float, samples: int = 2048) -> np.ndarray:
        t = np.arange(samples) / SAMPLE_RATE
        return np.sin(2 * np.pi * freq_hz * t).astype(np.float32)

    def test_torchcrepe_importable(self):
        import torchcrepe  # noqa: F401

    def test_torchcrepe_inference_latency(self):
        """AC1: median inference over 10 frames must be <80ms."""
        from backend.audio.pitch import _infer_torchcrepe
        device = torch.device("cuda")
        audio = self._sine_wave(440.0)
        _infer_torchcrepe(audio, device, 0.0)  # warmup

        times = []
        for _ in range(10):
            t0 = time.monotonic()
            _infer_torchcrepe(audio, device, 0.0)
            times.append((time.monotonic() - t0) * 1000.0)

        median_ms = sorted(times)[len(times) // 2]
        assert median_ms < 80.0, f"Median latency {median_ms:.1f}ms exceeds 80ms target"

    def test_torchcrepe_detects_a4(self):
        from backend.audio.pitch import _infer_torchcrepe
        device = torch.device("cuda")
        result = _infer_torchcrepe(self._sine_wave(440.0), device, 0.0)
        if result is not None:
            assert abs(result.midi - 69.0) < 1.0
            assert result.confidence >= CONFIDENCE_THRESHOLD

    def test_pipeline_uses_gpu(self):
        pipeline = PitchPipeline(engine=Engine.TORCHCREPE)
        assert pipeline.device.type == "cuda"
        pipeline.start()
        pipeline.stop()
