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
from fastapi.testclient import TestClient

from backend.audio.pipeline import PlaybackPipeline, PlaybackState
from backend.audio.pitch import PitchFrame
from backend.main import app


# ── PlaybackState machine ──────────────────────────────────────────────────────


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
        # Patch _capture and _pitch so no real hardware is touched
        p._capture = _MockCapture()
        p._pitch = _MockPitch()

        # Manually set state to PLAYING
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

        # t right after resume should be very close to t_at_pause (within a few ms)
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

    def test_double_start_is_safe(self):
        p = self._pipeline()
        p._capture = _MockCapture()
        p._pitch = _MockPitch()
        p._state = PlaybackState.PLAYING
        p.start()  # second start while PLAYING — must not raise or reset t
        assert p.state == PlaybackState.PLAYING


# ── Frame fan-out ──────────────────────────────────────────────────────────────
#
# Design note: _on_pitch_frame is called from the pitch worker thread.
# It uses loop.call_soon_threadsafe to schedule put_nowait on the asyncio
# event loop. For that to work, the loop must already be *running* when
# call_soon_threadsafe fires — otherwise the guard `not loop.is_running()`
# short-circuits and frames are silently dropped.
#
# The fix: run the loop with asyncio.run(), inject the frame from a thread
# pool executor (so call_soon_threadsafe finds a running loop), then yield
# once with `await asyncio.sleep(0)` to let put_nowait execute.


class TestFrameFanout:
    """AC1: pitch frames are delivered to all connected WS clients."""

    def test_frame_delivered_to_client(self):
        """Injecting a frame via _on_pitch_frame must reach a registered queue."""
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
            # Run from executor so the loop is running when call_soon_threadsafe fires
            await loop.run_in_executor(None, p._on_pitch_frame, frame)
            await asyncio.sleep(0)  # drain: let put_nowait callback execute

            assert not q.empty()
            payload = q.get_nowait()
            assert "t" in payload
            assert "midi" in payload
            assert "conf" in payload

        asyncio.run(_run())

    def test_frame_not_delivered_when_paused(self):
        """Frames received during PAUSED state must be discarded.

        No need for a running loop here: the guard in _on_pitch_frame returns
        early before reaching call_soon_threadsafe, so a stopped loop is fine.
        """
        loop = asyncio.new_event_loop()
        p = PlaybackPipeline()
        p._loop = loop
        p._state = PlaybackState.PAUSED
        p._elapsed_ms = 100.0

        q: asyncio.Queue = asyncio.Queue()
        p.add_client(q)

        frame = PitchFrame(time_ms=0.0, midi=69.0, confidence=0.9)
        p._on_pitch_frame(frame)  # must discard before touching loop
        loop.run_until_complete(asyncio.sleep(0))

        assert q.empty(), "Frame should not be delivered while paused"
        loop.close()

    def test_frame_delivered_to_multiple_clients(self):
        """All registered clients must receive each frame."""
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
        """A deregistered client must not receive frames.

        Same reasoning as the paused test: the client set is empty so
        call_soon_threadsafe is never called, and a stopped loop suffices.
        """
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
        """midi value in payload must be rounded to 3 decimal places."""
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

    def test_state_schema(self, client):
        resp = client.get("/playback/state")
        data = resp.json()
        assert isinstance(data["state"], str)
        assert isinstance(data["t_ms"], float)


# ── WebSocket endpoint ─────────────────────────────────────────────────────────


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
        # Second connection after first closes
        with client.websocket_connect("/ws/pitch") as ws:
            msg = ws.receive_json()
            assert msg == {"status": "connected"}


# ── Mock helpers ───────────────────────────────────────────────────────────────


class _MockCapture:
    """Stands in for MicCapture — no hardware interaction."""
    def start(self): pass
    def stop(self): pass
    active = False


class _MockPitch:
    """Stands in for PitchPipeline — no inference."""
    def start(self): pass
    def stop(self): pass
    def push(self, _): pass
