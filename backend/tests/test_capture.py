"""
Tests for backend/audio/capture.py — Day 4.

Three acceptance criteria from issue #2:
  AC1: GET /audio/devices returns at least one device on dev machine
  AC2: Ring buffer fills without dropping frames at 22050 Hz
  AC3: Device selection persists across a session (via AudioSession)

Hardware tests require real audio devices and are skipped in CI automatically.
Run locally with: uv run pytest -m hardware
"""

import logging
import threading
from unittest.mock import PropertyMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.audio.capture import (
    RingBuffer,
    WINDOW_SIZE,
    HOP_SIZE,
    SAMPLE_RATE,
    list_input_devices,
    default_input_device_id,
    AudioDevice,
    AudioSession,
    MicCapture,
)
from backend.main import app


# ── RingBuffer ─────────────────────────────────────────────────────────────────


class TestRingBuffer:
    def test_no_window_before_full(self):
        """Callback must not fire until a full window is accumulated."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))
        buf.push(np.zeros(WINDOW_SIZE - 1, dtype=np.float32))
        assert len(fired) == 0

    def test_window_fires_on_completion(self):
        """Exactly one window fires when we push the final sample."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))
        buf.push(np.zeros(WINDOW_SIZE, dtype=np.float32))
        assert len(fired) == 1
        assert fired[0].shape == (WINDOW_SIZE,)

    def test_window_content_is_correct(self):
        """The window should contain the samples we pushed."""
        received = []
        buf = RingBuffer(on_window=lambda w, _: received.append(w.copy()))
        samples = np.arange(WINDOW_SIZE, dtype=np.float32)
        buf.push(samples)
        assert np.allclose(received[0], samples)

    def test_overlap_second_window(self):
        """After the first window, pushing HOP_SIZE more samples triggers a second window."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))
        buf.push(np.ones(WINDOW_SIZE, dtype=np.float32))
        buf.push(np.full(HOP_SIZE, 2.0, dtype=np.float32))
        assert len(fired) == 2

    def test_overlap_content(self):
        """Second window should contain the last HOP_SIZE samples of the first block."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))

        first = np.ones(WINDOW_SIZE, dtype=np.float32)
        second_hop = np.full(HOP_SIZE, 9.0, dtype=np.float32)
        buf.push(first)
        buf.push(second_hop)

        w2 = fired[1]
        assert np.allclose(w2[:HOP_SIZE], 1.0)
        assert np.allclose(w2[HOP_SIZE:], 9.0)

    def test_small_chunks(self):
        """Pushing in small chunks should accumulate correctly."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))
        chunk = np.ones(64, dtype=np.float32)
        for _ in range(WINDOW_SIZE // 64):
            buf.push(chunk)
        assert len(fired) == 1

    def test_large_push_multiple_windows(self):
        """A push larger than WINDOW_SIZE should produce multiple windows."""
        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(w.copy()))
        buf.push(np.zeros(WINDOW_SIZE + HOP_SIZE * 2, dtype=np.float32))
        assert len(fired) >= 2

    def test_no_callback_no_crash(self):
        """RingBuffer without a callback should not raise."""
        buf = RingBuffer()
        buf.push(np.zeros(WINDOW_SIZE * 2, dtype=np.float32))

    # ── AC2: ring buffer fills without dropping frames at 22050 Hz ─────────────

    def test_throughput_at_22050hz(self):
        """
        AC2: Simulate 1 second of audio at 22050 Hz pushed in HOP_SIZE blocks
        (as sounddevice would deliver them) and verify every expected window fires.

        This is a simulation — no real audio hardware involved.
        """
        DURATION_S = 1.0
        total_samples = int(SAMPLE_RATE * DURATION_S)
        # Number of complete windows expected with 50% overlap:
        # first window at WINDOW_SIZE samples, then one per HOP_SIZE after that
        expected_windows = max(0, (total_samples - WINDOW_SIZE) // HOP_SIZE + 1)

        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(1))

        # Push in HOP_SIZE blocks — exactly how sounddevice delivers frames
        samples_pushed = 0
        block = np.zeros(HOP_SIZE, dtype=np.float32)
        while samples_pushed + HOP_SIZE <= total_samples:
            buf.push(block)
            samples_pushed += HOP_SIZE

        assert len(fired) >= expected_windows, (
            f"Expected >= {expected_windows} windows, got {len(fired)}"
        )

    def test_throughput_no_frames_dropped(self):
        """
        AC2 (no-drop variant): push 5 seconds of audio as fast as possible
        and verify window count is exactly right (no frames silently skipped).
        """
        DURATION_S = 5.0
        total_samples = int(SAMPLE_RATE * DURATION_S)
        expected_windows = max(0, (total_samples - WINDOW_SIZE) // HOP_SIZE + 1)

        fired = []
        buf = RingBuffer(on_window=lambda w, _: fired.append(1))

        # Push all at once — worst case for any naive implementation
        buf.push(np.zeros(total_samples, dtype=np.float32))

        assert len(fired) == expected_windows, (
            f"Frame drop detected: expected {expected_windows} windows, got {len(fired)}"
        )


# ── Device enumeration ─────────────────────────────────────────────────────────


class TestDeviceEnumeration:
    def test_list_input_devices_returns_list(self):
        """list_input_devices() must always return a list, even when empty."""
        devices = list_input_devices()
        assert isinstance(devices, list)

    @pytest.mark.hardware
    def test_at_least_one_input_device(self):
        """AC1 (unit): at least one input device exists on this machine."""
        devices = list_input_devices()
        assert len(devices) >= 1, "No input devices found"

    def test_device_fields(self):
        """Each returned device has the expected fields and types."""
        devices = list_input_devices()
        for d in devices:
            assert isinstance(d, AudioDevice)
            assert isinstance(d.id, int)
            assert isinstance(d.name, str) and d.name
            assert d.channels >= 1
            assert isinstance(d.host_api, str) and d.host_api
            assert d.default_sample_rate > 0

    def test_all_devices_are_inputs(self):
        devices = list_input_devices()
        for d in devices:
            assert d.channels >= 1

    @pytest.mark.hardware
    def test_default_device_id_is_int(self):
        """default_input_device_id() returns an int when a device is present."""
        assert isinstance(default_input_device_id(), int)

    @pytest.mark.hardware
    def test_default_device_in_list(self):
        devices = list_input_devices()
        ids = {d.id for d in devices}
        default_id = default_input_device_id()
        assert default_id in ids, f"Default device {default_id} not in input device list"


# ── AC1: GET /audio/devices HTTP endpoint ──────────────────────────────────────


class TestAudioDevicesEndpoint:
    """AC1: GET /audio/devices returns device list via the HTTP API.

    The endpoint always returns 200 — an empty device list is valid in CI.
    Hardware-dependent assertions (at least one device, default in list)
    are marked @pytest.mark.hardware and skipped in CI automatically.
    """

    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_endpoint_returns_200(self, client):
        resp = client.get("/audio/devices")
        assert resp.status_code == 200

    def test_endpoint_returns_json(self, client):
        resp = client.get("/audio/devices")
        data = resp.json()
        assert isinstance(data, dict)

    def test_endpoint_has_devices_key(self, client):
        resp = client.get("/audio/devices")
        data = resp.json()
        assert "devices" in data
        assert "default_device_id" in data

    @pytest.mark.hardware
    def test_endpoint_at_least_one_device(self, client):
        """AC1: the HTTP response must contain at least one input device."""
        resp = client.get("/audio/devices")
        data = resp.json()
        assert len(data["devices"]) >= 1, "GET /audio/devices returned empty device list"

    def test_endpoint_device_schema(self, client):
        """Each device in the response must have the expected fields."""
        resp = client.get("/audio/devices")
        for device in resp.json()["devices"]:
            assert "id" in device
            assert "name" in device
            assert "channels" in device
            assert "host_api" in device
            assert "default_sample_rate" in device

    @pytest.mark.hardware
    def test_endpoint_default_device_in_list(self, client):
        resp = client.get("/audio/devices")
        data = resp.json()
        ids = {d["id"] for d in data["devices"]}
        assert data["default_device_id"] in ids


# ── AC3: Device selection persists across a session ────────────────────────────


class TestAudioSession:
    """
    AC3: Device selection persists across a session.

    AudioSession is a lightweight state holder — no hardware involved here.
    Hardware persistence (selection surviving stop/start) is an integration
    test marked @pytest.mark.hardware.
    """

    def test_default_device_is_none(self):
        session = AudioSession()
        assert session.device_id is None

    def test_set_device_persists(self):
        session = AudioSession()
        session.device_id = 9
        assert session.device_id == 9

    def test_update_device_overwrites(self):
        session = AudioSession()
        session.device_id = 1
        session.device_id = 9
        assert session.device_id == 9

    def test_reset_clears_device(self):
        session = AudioSession()
        session.device_id = 9
        session.reset()
        assert session.device_id is None

    def test_device_persists_through_multiple_reads(self):
        session = AudioSession()
        session.device_id = 5
        for _ in range(10):
            assert session.device_id == 5

    def test_session_is_independent(self):
        """Two sessions should not share state."""
        s1 = AudioSession()
        s2 = AudioSession()
        s1.device_id = 3
        assert s2.device_id is None

    def test_thread_safety(self):
        """Concurrent writes to the same session should not corrupt state."""
        session = AudioSession()
        errors = []

        def write(val):
            try:
                for _ in range(1000):
                    session.device_id = val
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=write, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert session.device_id in {0, 1, 2, 3}


class _CallbackFlagsDouble:
    """Minimal stand-in for ``sounddevice.CallbackFlags`` used by callback tests."""

    def __init__(self, **kwargs) -> None:
        self.input_overflow = bool(kwargs.get("input_overflow", False))
        self.output_underflow = bool(kwargs.get("output_underflow", False))
        self.priming_output = bool(kwargs.get("priming_output", False))

    def __bool__(self) -> bool:
        return self.input_overflow or self.output_underflow or self.priming_output

    def __str__(self) -> str:
        active = []
        if self.input_overflow:
            active.append("input overflow")
        if self.output_underflow:
            active.append("output underflow")
        if self.priming_output:
            active.append("priming output")
        return ", ".join(active) if active else "no status"


def _make_callback_flags(**kwargs) -> _CallbackFlagsDouble:
    """Build a truthy callback-status object with the requested flags."""
    return _CallbackFlagsDouble(**kwargs)


class TestMicCapture:
    def test_nonzero_status_logs_warning_and_tracks_xruns(self, caplog):
        capture = MicCapture(on_window=lambda _window: None)
        indata = np.zeros((HOP_SIZE, 1), dtype=np.float32)
        status = _make_callback_flags(input_overflow=True)

        with caplog.at_level(logging.WARNING, logger="backend.audio.capture"):
            capture._callback(indata, HOP_SIZE, None, status)

        assert capture.xrun_count == 1
        assert "sounddevice input overflow" in caplog.text

    @pytest.mark.parametrize(
        ("status_kwargs", "log_level", "expected_message"),
        [
            ({"output_underflow": True}, logging.WARNING, "sounddevice output underflow"),
            ({"priming_output": True}, logging.DEBUG, "sounddevice priming output"),
        ],
    )
    def test_known_status_flags_are_logged(
        self, caplog, status_kwargs, log_level, expected_message
    ):
        capture = MicCapture(on_window=lambda _window: None)
        indata = np.zeros((HOP_SIZE, 1), dtype=np.float32)
        status = _make_callback_flags(**status_kwargs)

        with caplog.at_level(logging.DEBUG, logger="backend.audio.capture"):
            capture._callback(indata, HOP_SIZE, None, status)

        assert capture.xrun_count == 1
        assert any(
            record.levelno == log_level and expected_message in record.message
            for record in caplog.records
        )

    def test_unknown_status_falls_back_to_generic_warning(self, caplog):
        capture = MicCapture(on_window=lambda _window: None)
        indata = np.zeros((HOP_SIZE, 1), dtype=np.float32)

        class _UnknownStatus:
            def __bool__(self):
                return True

            def __str__(self):
                return "unknown status"

        with caplog.at_level(logging.WARNING, logger="backend.audio.capture"):
            capture._callback(indata, HOP_SIZE, None, _UnknownStatus())

        assert capture.xrun_count == 1
        assert "sounddevice status: unknown status" in caplog.text


class TestAudioEngineEndpoint:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_endpoint_returns_200(self, client):
        resp = client.get("/audio/engine")
        assert resp.status_code == 200

    def test_endpoint_shape(self, client):
        data = client.get("/audio/engine").json()
        assert data["active_engine"] in {"pyin", "torchcrepe"}
        assert data["mode"] in {"auto", "forced_cpu"}
        assert isinstance(data["switchable"], bool)
        assert "cuda" in data
        assert "device" in data
        assert "force_cpu" in data
        assert data["xrun_count"] == 0

    def test_capture_status_endpoint(self, client):
        with patch("backend.audio.pipeline.PlaybackPipeline.xrun_count", new_callable=PropertyMock) as mock_xrun_count:
            mock_xrun_count.return_value = 4
            resp = client.get("/audio/capture/status")

        assert resp.status_code == 200
        assert resp.json() == {"xrun_count": 4}

    def test_force_cpu_toggle(self, client):
        enabled = client.post("/audio/engine/force-cpu", params={"force_cpu": True}).json()
        assert enabled["active_engine"] == "pyin"
        assert enabled["force_cpu"] is True

        disabled = client.post("/audio/engine/force-cpu", params={"force_cpu": False}).json()
        assert disabled["force_cpu"] is False


class TestHealthEndpoint:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_health_includes_engine_info(self, client):
        data = client.get("/health").json()
        assert data["status"] == "ok"
        assert data["engine"] in {"pyin", "torchcrepe"}
        assert isinstance(data["cuda"], bool)
        assert isinstance(data["device"], str)
