"""
Tests for backend/audio/capture.py — Day 4.

MicCapture itself isn't tested here (needs real hardware / integration test).
We test the pure-logic components: RingBuffer and device enumeration helpers.
"""

import numpy as np
import pytest

from backend.audio.capture import (
    RingBuffer,
    WINDOW_SIZE,
    HOP_SIZE,
    list_input_devices,
    default_input_device_id,
    AudioDevice,
)


# ── RingBuffer ─────────────────────────────────────────────────────────────────


class TestRingBuffer:
    def test_no_window_before_full(self):
        """Callback must not fire until a full window is accumulated."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))
        buf.push(np.zeros(WINDOW_SIZE - 1, dtype=np.float32))
        assert len(fired) == 0

    def test_window_fires_on_completion(self):
        """Exactly one window fires when we push the final sample."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))
        buf.push(np.zeros(WINDOW_SIZE, dtype=np.float32))
        assert len(fired) == 1
        assert fired[0].shape == (WINDOW_SIZE,)

    def test_window_content_is_correct(self):
        """The window should contain the samples we pushed."""
        received = []
        buf = RingBuffer(on_window=lambda w: received.append(w.copy()))
        samples = np.arange(WINDOW_SIZE, dtype=np.float32)
        buf.push(samples)
        assert np.allclose(received[0], samples)

    def test_overlap_second_window(self):
        """After the first window, pushing HOP_SIZE more samples triggers a second window."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))
        buf.push(np.ones(WINDOW_SIZE, dtype=np.float32))
        buf.push(np.full(HOP_SIZE, 2.0, dtype=np.float32))
        assert len(fired) == 2

    def test_overlap_content(self):
        """Second window should contain the last HOP_SIZE samples of the first block."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))

        first = np.ones(WINDOW_SIZE, dtype=np.float32)
        second_hop = np.full(HOP_SIZE, 9.0, dtype=np.float32)
        buf.push(first)
        buf.push(second_hop)

        # Second window: first half is tail of 'first', second half is 'second_hop'
        w2 = fired[1]
        assert np.allclose(w2[:HOP_SIZE], 1.0)
        assert np.allclose(w2[HOP_SIZE:], 9.0)

    def test_small_chunks(self):
        """Pushing in small chunks should accumulate correctly."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))
        chunk = np.ones(64, dtype=np.float32)
        for _ in range(WINDOW_SIZE // 64):
            buf.push(chunk)
        assert len(fired) == 1

    def test_large_push_multiple_windows(self):
        """A push larger than WINDOW_SIZE should produce multiple windows."""
        fired = []
        buf = RingBuffer(on_window=lambda w: fired.append(w.copy()))
        # 3 hops beyond initial window → should produce multiple windows
        buf.push(np.zeros(WINDOW_SIZE + HOP_SIZE * 2, dtype=np.float32))
        assert len(fired) >= 2

    def test_no_callback_no_crash(self):
        """RingBuffer without a callback should not raise."""
        buf = RingBuffer()
        buf.push(np.zeros(WINDOW_SIZE * 2, dtype=np.float32))


# ── Device enumeration ─────────────────────────────────────────────────────────


class TestDeviceEnumeration:
    def test_list_input_devices_returns_list(self):
        devices = list_input_devices()
        assert isinstance(devices, list)

    def test_at_least_one_input_device(self):
        """Dev machine must have at least one input device."""
        devices = list_input_devices()
        assert len(devices) >= 1, "No input devices found"

    def test_device_fields(self):
        devices = list_input_devices()
        for d in devices:
            assert isinstance(d, AudioDevice)
            assert isinstance(d.id, int)
            assert isinstance(d.name, str) and d.name
            assert d.channels >= 1
            assert isinstance(d.host_api, str) and d.host_api
            assert d.default_sample_rate > 0

    def test_all_devices_are_inputs(self):
        """list_input_devices must not return output-only devices."""
        devices = list_input_devices()
        for d in devices:
            assert d.channels >= 1

    def test_default_device_id_is_int(self):
        dev_id = default_input_device_id()
        assert isinstance(dev_id, int)

    def test_default_device_in_list(self):
        """The default device ID should appear in the list of input devices."""
        devices = list_input_devices()
        ids = {d.id for d in devices}
        default_id = default_input_device_id()
        assert default_id in ids, f"Default device {default_id} not in input device list"
