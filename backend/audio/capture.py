"""
backend/audio/capture.py

Microphone capture using sounddevice.
Fills a ring buffer with overlapping 2048-sample windows at 22050 Hz.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import sounddevice as sd

# ── Constants ──────────────────────────────────────────────────────────────────

SAMPLE_RATE: int = 22050
WINDOW_SIZE: int = 2048       # samples per analysis window (~93 ms)
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


def default_input_device_id() -> int:
    """Return sounddevice's current default input device index."""
    return sd.query_devices(kind="input")["index"]  # type: ignore[index]


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
        on_window: Callable[[np.ndarray], None] | None = None,
    ) -> None:
        self._window_size = window_size
        self._hop_size = hop_size
        self._on_window = on_window
        self._buf = np.zeros(window_size, dtype=np.float32)
        self._fill = 0          # samples written into _buf
        self._dropped = 0       # frames dropped (buffer full)

    def push(self, samples: np.ndarray) -> None:
        """
        Push a block of mono float32 samples.  Called from the audio thread.
        """
        offset = 0
        while offset < len(samples):
            space = self._window_size - self._fill
            chunk = samples[offset : offset + space]
            self._buf[self._fill : self._fill + len(chunk)] = chunk
            self._fill += len(chunk)
            offset += len(chunk)

            if self._fill == self._window_size:
                if self._on_window:
                    self._on_window(self._buf.copy())
                # Slide by hop_size (50% overlap)
                self._buf[: self._window_size - self._hop_size] = self._buf[
                    self._hop_size :
                ]
                self._fill = self._window_size - self._hop_size

    @property
    def dropped(self) -> int:
        return self._dropped


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
        on_window: Callable[[np.ndarray], None] | None = None,
    ) -> None:
        self._device_id = device_id  # None → sounddevice default
        self._sample_rate = sample_rate
        self._ring = RingBuffer(on_window=on_window)
        self._stream: sd.InputStream | None = None
        self._lock = threading.Lock()

    # ── Public API ─────────────────────────────────────────────────────────

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                return  # already running
            self._stream = sd.InputStream(
                device=self._device_id,
                channels=1,
                samplerate=self._sample_rate,
                dtype="float32",
                blocksize=HOP_SIZE,   # callback fires every hop
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

    # ── Internal ───────────────────────────────────────────────────────────

    def _callback(
        self,
        indata: np.ndarray,
        frames: int,
        time,       # CData — not used
        status: sd.CallbackFlags,
    ) -> None:
        if status:
            # Log but don't crash — overflow/underrun in real-time thread
            print(f"[capture] sounddevice status: {status}")
        mono = indata[:, 0]   # take channel 0 (mic array is stereo, we want mono)
        self._ring.push(mono)
