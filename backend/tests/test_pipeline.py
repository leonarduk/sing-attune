"""
Tests for backend/audio/pipeline.py and playback endpoints — Day 6.

Acceptance criteria from issue #4:
  AC1: Frontend receives pitch frames at ~20Hz during active playback
  AC2: t=0 on backend aligns with AudioContext.currentTime t=0 on frontend
  AC3: Pause/resume does not cause timestamp discontinuity
  AC4: WebSocket reconnects cleanly if connection drops

Hardware tests (real mic) are excluded — pipeline logic is tested with
a mock pitch source injected via on_frame callback.
"""

import asyncio
import time

import pytest
import torch
from fastapi.testclient import TestClient

from backend.audio.pipeline import PlaybackPipeline, PlaybackState
from backend.audio.pitch import PitchFrame
from backend.main import app


# ── PlaybackState machine ─────────────────────────────────────────────────────────────


class TestPlaybackStateMachine:
    def _pipeline(self) -> PlaybackPipeline:
        from backend.audio.pitch import Engine
        # Use PYIN so we don't need a mic; we'll inject frames manually anyway
        return PlaybackPipeline(engine=Engine.PYIN)

    def test_initial_state_is_stopped(self):
        assert self._pipeline().state == PlaybackState.STOPPED

    def test_stop_when_already_stopped_is_safe(self):
        p = self._pipeline()
        p.stop()  # must not raise

    def test_pause_when_stopped_is_safe(self):
        p = self._pipeline()
        p.pause()  # must not raise
        assert p.state == PlaybackState.STOPPED

    def test_resume_when_stopped_is_safe(self):
        p = self._pipeline()
        p.resume()  # must not raise
        assert p.state == PlaybackState.STOPPED

    def test_elapsed_ms_zero_when_stopped(self):
        assert self._pipeline().elapsed_ms == 0.0

    def test_elapsed_ms_increases_while_playing(self):
        """AC2: t should advance monotonically during playback."""
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 0.0

        t1 = p.elapsed_ms
        time.sleep(0.05)
        t2 = p.elapsed_ms
        assert t2 > t1, f"elapsed_ms did not advance: {t1} -> {t2}"

    def test_pause_holds_t(self):
        """AC3: elapsed_ms must not change while paused."""
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 100.0

        p.pause()
        assert p.state == PlaybackState.PAUSED
        t_at_pause = p.elapsed_ms
        time.sleep(0.05)
        assert p.elapsed_ms == t_at_pause, "elapsed_ms changed while paused"

    def test_resume_continues_from_paused_t(self):
        """AC3: after resume, t continues from where pause left it."""
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 500.0

        time.sleep(0.02)
        p.pause()
        t_at_pause = p.elapsed_ms

        time.sleep(0.05)  # time passes while paused
        p.resume()

        t_after_resume = p.elapsed_ms
        assert abs(t_after_resume - t_at_pause) < 20.0, (
            f"Discontinuity: paused at {t_at_pause:.1f}ms, "
            f"resumed at {t_after_resume:.1f}ms"
        )

    def test_stop_resets_t_to_zero(self):
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 1000.0

        p.stop()
        assert p.state == PlaybackState.STOPPED
        assert p.elapsed_ms == 0.0

    def test_seek_updates_elapsed_while_paused(self):
        p = self._pipeline()
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 400.0
        p.seek(1250.0)
        assert p.elapsed_ms == 1250.0

    def test_seek_resets_play_anchor_while_playing(self):
        p = self._pipeline()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic() - 0.5
        p._elapsed_ms = 300.0

        p.seek(900.0)
        t_after_seek = p.elapsed_ms
        time.sleep(0.02)

        assert 900.0 <= t_after_seek < 940.0
        assert p.elapsed_ms > t_after_seek

    def test_seek_is_noop_when_stopped(self):
        p = self._pipeline()
        p.seek(1000.0)
        assert p.state == PlaybackState.STOPPED
        assert p.elapsed_ms == 0.0

    def test_tempo_multiplier_scales_elapsed_while_playing(self):
        p = self._pipeline()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 0.0
        p.set_tempo_multiplier(1.5)
        time.sleep(0.03)
        assert p.elapsed_ms >= 40.0

    def test_set_tempo_multiplier_while_stopped_only_stores_value(self):
        p = self._pipeline()
        p.set_tempo_multiplier(2.0)
        assert p.tempo_multiplier == pytest.approx(2.0)
        assert p.elapsed_ms == 0.0

    def test_set_tempo_multiplier_while_paused_only_stores_value(self):
        p = self._pipeline()
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 300.0
        p.set_tempo_multiplier(0.75)
        assert p.tempo_multiplier == pytest.approx(0.75)
        assert p.elapsed_ms == pytest.approx(300.0)

    def test_set_tempo_multiplier_rejects_zero_directly(self):
        p = self._pipeline()
        with pytest.raises(ValueError, match="multiplier must be > 0"):
            p.set_tempo_multiplier(0)

    def test_set_transpose_semitones_stores_value(self):
        p = self._pipeline()
        p.set_transpose_semitones(3)
        assert p.transpose_semitones == 3

    def test_set_transpose_semitones_clamps_to_plus_12(self):
        p = self._pipeline()
        p.set_transpose_semitones(99)
        assert p.transpose_semitones == 12

    def test_set_transpose_semitones_clamps_to_minus_12(self):
        p = self._pipeline()
        p.set_transpose_semitones(-99)
        assert p.transpose_semitones == -12

    def test_set_transpose_semitones_allows_zero(self):
        p = self._pipeline()
        p.set_transpose_semitones(7)
        p.set_transpose_semitones(0)
        assert p.transpose_semitones == 0

    def test_double_start_is_safe(self):
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p.start()  # second start while PLAYING — must not raise or reset t
        assert p.state == PlaybackState.PLAYING


# ── set_force_cpu ─────────────────────────────────────────────────────────────


def _patch_pipeline_hardware(monkeypatch):
    """Replace MicCapture and PitchPipeline in the pipeline module with no-op fakes."""
    import backend.audio.pipeline as pipeline_mod
    monkeypatch.setattr(pipeline_mod, "MicCapture", _FakeMicCapture)
    monkeypatch.setattr(pipeline_mod, "PitchPipeline", _FakePitchPipeline)


class _FakeMicCapture:
    """No-op replacement for MicCapture — accepts the same constructor args."""
    def __init__(self, device_id=None, on_window=None):
        self.device_id = device_id
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class _FakePitchPipeline:
    """No-op replacement for PitchPipeline — accepts the same constructor args."""
    def __init__(self, engine=None, on_frame=None):
        self.engine = engine
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def push(self, _):
        pass


class TestSetForceCpu:
    """Tests for the live engine-switching hot-swap path (the 8 uncovered lines)."""

    def _pipeline(self) -> PlaybackPipeline:
        from backend.audio.pitch import Engine
        return PlaybackPipeline(engine=Engine.PYIN)

    def test_set_force_cpu_true_when_stopped(self, monkeypatch):
        """STOPPED: no hardware rebuilt, just updates flags."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        p = self._pipeline()
        p.set_force_cpu(True)
        assert p.force_cpu is True
        assert p.runtime_info.mode == "forced_cpu"
        assert p.state == PlaybackState.STOPPED

    def test_set_force_cpu_false_when_stopped(self, monkeypatch):
        """Disabling force_cpu on STOPPED pipeline leaves state unchanged."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        p = self._pipeline()
        p.set_force_cpu(True)
        p.set_force_cpu(False)
        assert p.force_cpu is False
        assert p.state == PlaybackState.STOPPED

    def test_set_force_cpu_when_playing_rebuilds_and_restores_playing(self, monkeypatch):
        """PLAYING: teardown + rebuild, state restored to PLAYING."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        _patch_pipeline_hardware(monkeypatch)

        p = self._pipeline()
        original_capture = _MockCapture()
        original_pitch = _MockPitch()
        p._capture = original_capture
        p._pitch = original_pitch
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()

        p.set_force_cpu(True)

        assert p.state == PlaybackState.PLAYING
        assert p.force_cpu is True
        assert original_capture.stopped is True
        assert original_pitch.stopped is True
        assert p._capture is not original_capture
        assert p._pitch is not original_pitch
        assert p._capture.started is True
        assert p._pitch.started is True

    def test_set_force_cpu_when_paused_rebuilds_and_restores_paused(self, monkeypatch):
        """PAUSED: teardown + rebuild, state restored to PAUSED, capture NOT started."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        _patch_pipeline_hardware(monkeypatch)

        p = self._pipeline()
        original_capture = _MockCapture()
        original_pitch = _MockPitch()
        p._capture = original_capture
        p._pitch = original_pitch
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 750.0

        p.set_force_cpu(True)

        assert p.state == PlaybackState.PAUSED
        assert p.force_cpu is True
        assert original_capture.stopped is True
        assert original_pitch.stopped is True
        assert p._capture is not original_capture
        assert p._pitch is not original_pitch
        assert p._capture.started is False
        assert p._pitch.started is True

    def test_elapsed_ms_continuous_through_hot_swap_while_playing(self, monkeypatch):
        """elapsed_ms must not jump backwards or forwards discontinuously after hot-swap."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        _patch_pipeline_hardware(monkeypatch)

        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 500.0

        time.sleep(0.02)  # let some time accumulate
        t_before = p.elapsed_ms
        p.set_force_cpu(True)
        t_after = p.elapsed_ms

        # elapsed_ms should be within 30ms of where it was before the swap
        assert abs(t_after - t_before) < 30.0, (
            f"elapsed_ms jumped discontinuously: {t_before:.1f}ms → {t_after:.1f}ms"
        )
        assert p.state == PlaybackState.PLAYING

    def test_elapsed_ms_preserved_through_hot_swap_while_paused(self, monkeypatch):
        """elapsed_ms must be exactly preserved after hot-swap from PAUSED state."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
        _patch_pipeline_hardware(monkeypatch)

        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 1234.5

        p.set_force_cpu(True)

        assert p.elapsed_ms == pytest.approx(1234.5)
        assert p.state == PlaybackState.PAUSED

    def test_set_force_cpu_preserves_device_id(self, monkeypatch):
        """device_id from the old capture must be forwarded to the new MicCapture."""
        monkeypatch.delenv("PITCH_ENGINE", raising=False)
        monkeypatch.setattr(torch.cuda, "is_available", lambda: False)

        import backend.audio.pipeline as pipeline_mod

        created_with_device_id = []

        class RecordingMicCapture:
            def __init__(self, device_id=None, on_window=None):
                created_with_device_id.append(device_id)
                self.device_id = device_id
            def start(self): pass
            def stop(self): pass

        monkeypatch.setattr(pipeline_mod, "MicCapture", RecordingMicCapture)
        monkeypatch.setattr(pipeline_mod, "PitchPipeline", _FakePitchPipeline)

        p = self._pipeline()
        p._capture = _MockCaptureWithDeviceId(device_id=7)
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()

        p.set_force_cpu(True)

        assert created_with_device_id == [7]


# ── Frame fan-out ─────────────────────────────────────────────────────────────


class TestFrameFanout:
    """AC1: pitch frames are delivered to all connected WS clients."""

    def test_frame_delivered_to_client(self):
        async def _run():
            loop = asyncio.get_event_loop()
            p = PlaybackPipeline()
            p._loop = loop
            p._state = PlaybackState.PLAYING
            p._play_monotonic = time.monotonic()
            p._elapsed_ms = 0.0

            q: asyncio.Queue = asyncio.Queue()
            p.add_client(q)

            frame = PitchFrame(time_ms=0.0, midi=69.0, confidence=0.9)
            await loop.run_in_executor(None, p._on_pitch_frame, frame)
            await asyncio.sleep(0)

            assert not q.empty()
            payload = q.get_nowait()
            assert "t" in payload
            assert "midi" in payload
            assert "conf" in payload

        asyncio.run(_run())

    def test_frame_not_delivered_when_paused(self):
        loop = asyncio.new_event_loop()
        p = PlaybackPipeline()
        p._loop = loop
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 100.0

        q: asyncio.Queue = asyncio.Queue()
        p.add_client(q)

        frame = PitchFrame(time_ms=0.0, midi=69.0, confidence=0.9)
        p._on_pitch_frame(frame)
        loop.run_until_complete(asyncio.sleep(0))

        assert q.empty(), "Frame should not be delivered while paused"
        loop.close()

    def test_frame_delivered_to_multiple_clients(self):
        async def _run():
            loop = asyncio.get_event_loop()
            p = PlaybackPipeline()
            p._loop = loop
            p._state = PlaybackState.PLAYING
            p._play_monotonic = time.monotonic()
            p._elapsed_ms = 0.0

            queues = [asyncio.Queue() for _ in range(3)]
            for q in queues:
                p.add_client(q)

            frame = PitchFrame(time_ms=0.0, midi=60.0, confidence=0.8)
            await loop.run_in_executor(None, p._on_pitch_frame, frame)
            await asyncio.sleep(0)

            for i, q in enumerate(queues):
                assert not q.empty(), f"Client {i} did not receive frame"

        asyncio.run(_run())

    def test_removed_client_gets_no_frames(self):
        loop = asyncio.new_event_loop()
        p = PlaybackPipeline()
        p._loop = loop
        p._state = PlaybackState.PLAYING
        p._play_monotonic = time.monotonic()
        p._elapsed_ms = 0.0

        q: asyncio.Queue = asyncio.Queue()
        p.add_client(q)
        p.remove_client(q)

        frame = PitchFrame(time_ms=0.0, midi=60.0, confidence=0.8)
        p._on_pitch_frame(frame)
        loop.run_until_complete(asyncio.sleep(0))

        assert q.empty()
        loop.close()

    def test_midi_rounded_to_3dp(self):
        async def _run():
            loop = asyncio.get_event_loop()
            p = PlaybackPipeline()
            p._loop = loop
            p._state = PlaybackState.PLAYING
            p._play_monotonic = time.monotonic()
            p._elapsed_ms = 0.0

            q: asyncio.Queue = asyncio.Queue()
            p.add_client(q)

            frame = PitchFrame(time_ms=0.0, midi=60.123456789, confidence=0.9)
            await loop.run_in_executor(None, p._on_pitch_frame, frame)
            await asyncio.sleep(0)

            payload = q.get_nowait()
            assert payload["midi"] == round(60.123456789, 3)

        asyncio.run(_run())

    def test_frame_timestamp_uses_capture_time_not_emit_time(self):
        async def _run():
            loop = asyncio.get_event_loop()
            p = PlaybackPipeline()
            p._loop = loop
            p._state = PlaybackState.PLAYING
            p._play_monotonic = 10.0
            p._elapsed_ms = 250.0
            p._tempo_multiplier = 1.0

            q: asyncio.Queue = asyncio.Queue()
            p.add_client(q)

            frame = PitchFrame(time_ms=10250.0, midi=60.0, confidence=0.8)
            await loop.run_in_executor(None, p._on_pitch_frame, frame)
            await asyncio.sleep(0)

            payload = q.get_nowait()
            assert payload["t"] == pytest.approx(500.0)

        asyncio.run(_run())


# ── HTTP endpoints ─────────────────────────────────────────────────────────────


class TestPlaybackEndpoints:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_playback_state_endpoint(self, client):
        resp = client.get("/playback/state")
        assert resp.status_code == 200
        data = resp.json()
        assert "state" in data
        assert "t_ms" in data

    def test_playback_stop_returns_200(self, client):
        resp = client.post("/playback/stop")
        assert resp.status_code == 200
        assert resp.json()["state"] == "STOPPED"
        assert resp.json()["t_ms"] == 0.0

    def test_playback_pause_when_stopped_returns_200(self, client):
        client.post("/playback/stop")
        resp = client.post("/playback/pause")
        assert resp.status_code == 200
        assert resp.json()["state"] == "STOPPED"

    def test_playback_resume_when_stopped_returns_200(self, client):
        client.post("/playback/stop")
        resp = client.post("/playback/resume")
        assert resp.status_code == 200

    def test_playback_seek_returns_200(self, client):
        client.post('/playback/stop')
        resp = client.post('/playback/seek?t_ms=2500')
        assert resp.status_code == 200
        data = resp.json()
        assert data['state'] == 'STOPPED'
        assert data['t_ms'] == 0.0

    def test_playback_seek_rejects_negative_t(self, client):
        resp = client.post('/playback/seek?t_ms=-1')
        assert resp.status_code == 400

    def test_playback_tempo_returns_200(self, client):
        resp = client.post('/playback/tempo?multiplier=1.25')
        assert resp.status_code == 200
        data = resp.json()
        assert data['multiplier'] == pytest.approx(1.25)

    def test_playback_tempo_rejects_invalid_multiplier(self, client):
        resp = client.post('/playback/tempo?multiplier=0')
        assert resp.status_code == 400

    def test_playback_transpose_returns_200(self, client):
        resp = client.post('/playback/transpose?semitones=3')
        assert resp.status_code == 200
        data = resp.json()
        assert data['transpose_semitones'] == 3

    def test_playback_transpose_negative_semitones(self, client):
        resp = client.post('/playback/transpose?semitones=-5')
        assert resp.status_code == 200
        assert resp.json()['transpose_semitones'] == -5

    def test_playback_transpose_clamps_out_of_range(self, client):
        resp = client.post('/playback/transpose?semitones=99')
        assert resp.status_code == 200
        assert resp.json()['transpose_semitones'] == 12

    def test_playback_transpose_zero_resets(self, client):
        client.post('/playback/transpose?semitones=6')
        resp = client.post('/playback/transpose?semitones=0')
        assert resp.status_code == 200
        assert resp.json()['transpose_semitones'] == 0

    def test_playback_transpose_returns_state_and_t_ms(self, client):
        resp = client.post('/playback/transpose?semitones=2')
        data = resp.json()
        assert 'state' in data
        assert 't_ms' in data
        assert 'transpose_semitones' in data

    def test_state_schema(self, client):
        resp = client.get("/playback/state")
        data = resp.json()
        assert isinstance(data["state"], str)
        assert isinstance(data["t_ms"], float)


# ── WebSocket endpoint ─────────────────────────────────────────────────────────────


class TestWebSocketEndpoint:
    """AC4: WebSocket connects cleanly and receives status frame."""

    def test_websocket_connects(self):
        client = TestClient(app)
        with client.websocket_connect("/ws/pitch") as ws:
            msg = ws.receive_json()
            assert msg == {"status": "connected"}

    def test_websocket_reconnects_cleanly(self):
        """AC4: closing and reopening the WebSocket must work without error."""
        client = TestClient(app)
        with client.websocket_connect("/ws/pitch") as ws:
            ws.receive_json()  # consume "connected"
        with client.websocket_connect("/ws/pitch") as ws:
            msg = ws.receive_json()
            assert msg == {"status": "connected"}


# ── Mock helpers ─────────────────────────────────────────────────────────────


class _MockCapture:
    """Minimal stand-in for MicCapture used where no construction args are needed."""
    device_id = None
    def __init__(self):
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class _MockCaptureWithDeviceId:
    """Stand-in for MicCapture when the device_id value needs to be inspected."""
    def __init__(self, device_id):
        self.device_id = device_id
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class _MockPitch:
    """Stands in for PitchPipeline — no inference."""
    def __init__(self):
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def push(self, _):
        pass
