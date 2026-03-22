"""
backend/audio/capture.py

Microphone capture using sounddevice.
Fills a ring buffer with overlapping 2048-sample windows at 22050 Hz.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

SAMPLE_RATE: int = 22050
WINDOW_SIZE: int = 2048           # samples per analysis window (~93 ms)
HOP_SIZE: int = WINDOW_SIZE // 2  # 50% overlap (~46 ms hop)

# ── Device helpers ─────────────────────────────────────────────────────────────


@dataclass
class AudioDevice:
    id: int
    name: str
    channels: int
    host_api: str
    default_sample_rate: float


def list_input_devices() -> list[AudioDevice]:
    """Return all input devices (channels_in > 0)."""
    devices = []
    host_apis = sd.query_hostapis()
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            devices.append(
                AudioDevice(
                    id=idx,
                    name=dev["name"],
                    channels=dev["max_input_channels"],
                    host_api=host_apis[dev["hostapi"]]["name"],
                    default_sample_rate=dev["default_samplerate"],
                )
            )
    return devices


def default_input_device_id() -> int | None:
    """Return sounddevice's current default input device index.

    Returns None if no input devices are available (e.g. in CI).
    """
    try:
        return sd.query_devices(kind="input")["index"]  # type: ignore[index]
    except sd.PortAudioError:
        return None


# ── Session state ──────────────────────────────────────────────────────────────


class AudioSession:
    """
    Holds user-selected audio settings for the duration of a session.

    Lightweight, thread-safe state holder — no hardware involved.
    Persists the selected device_id so MicCapture can be stopped and
    restarted (e.g. after settings change) without losing the selection.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._device_id: int | None = None

    @property
    def device_id(self) -> int | None:
        with self._lock:
            return self._device_id

    @device_id.setter
    def device_id(self, value: int | None) -> None:
        with self._lock:
            self._device_id = value

    def reset(self) -> None:
        """Clear all session state."""
        with self._lock:
            self._device_id = None


# ── Ring buffer ────────────────────────────────────────────────────────────────


class RingBuffer:
    """
    Accumulates incoming audio samples and yields fixed-size, overlapping
    windows via a callback.

    Thread-safe: the sounddevice callback writes from an audio thread;
    the window callback fires on that same thread (keep it fast).
    """

    def __init__(
        self,
        window_size: int = WINDOW_SIZE,
        hop_size: int = HOP_SIZE,
        on_window: Callable[[np.ndarray, float], None] | None = None,
    ) -> None:
        self._window_size = window_size
        self._hop_size = hop_size
        self._on_window = on_window
        self._buf = np.zeros(window_size, dtype=np.float32)
        self._fill = 0

    def push(self, samples: np.ndarray) -> None:
        """Push a block of mono float32 samples. Called from the audio thread."""
        offset = 0
        while offset < len(samples):
            space = self._window_size - self._fill
            chunk = samples[offset : offset + space]
            self._buf[self._fill : self._fill + len(chunk)] = chunk
            self._fill += len(chunk)
            offset += len(chunk)

            if self._fill == self._window_size:
                if self._on_window:
                    self._on_window(self._buf.copy(), time.monotonic() * 1000.0)
                # Slide by hop_size (50% overlap)
                self._buf[: self._window_size - self._hop_size] = self._buf[
                    self._hop_size :
                ]
                self._fill = self._window_size - self._hop_size


# ── Capture stream ─────────────────────────────────────────────────────────────


class MicCapture:
    """
    Opens a sounddevice InputStream and feeds samples into a RingBuffer.

    Usage:
        cap = MicCapture(device_id=9, on_window=my_callback)
        cap.start()
        ...
        cap.stop()
    """

    def __init__(
        self,
        device_id: int | None = None,
        sample_rate: int = SAMPLE_RATE,
        on_window: Callable[[np.ndarray, float], None] | None = None,
    ) -> None:
        self._device_id = device_id  # None → sounddevice default
        self._sample_rate = sample_rate
        self._ring = RingBuffer(on_window=on_window)
        self._stream: sd.InputStream | None = None
        self._lock = threading.Lock()
        self._xrun_count = 0

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                return
            self._stream = sd.InputStream(
                device=self._device_id,
                channels=1,
                samplerate=self._sample_rate,
                dtype="float32",
                blocksize=HOP_SIZE,
                callback=self._callback,
            )
            self._stream.start()

    def stop(self) -> None:
        with self._lock:
            if self._stream is None:
                return
            self._stream.stop()
            self._stream.close()
            self._stream = None

    @property
    def active(self) -> bool:
        return self._stream is not None and self._stream.active

    @property
    def device_id(self) -> int | None:
        return self._device_id

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def xrun_count(self) -> int:
        return self._xrun_count

    def _callback(
        self,
        indata: np.ndarray,
        frames: int,
        time,
        status: sd.CallbackFlags,
    ) -> None:
        if status:
            self._xrun_count += 1
            input_overflow = bool(getattr(status, "input_overflow", False))
            output_underflow = bool(getattr(status, "output_underflow", False))
            priming_output = bool(getattr(status, "priming_output", False))

            if input_overflow:
                log.warning("sounddevice input overflow: %s", status)
            if output_underflow:
                log.warning("sounddevice output underflow: %s", status)
            if priming_output:
                log.debug("sounddevice priming output: %s", status)
            if not (input_overflow or output_underflow or priming_output):
                log.warning("sounddevice status: %s", status)
        mono = indata[:, 0]
        self._ring.push(mono)
