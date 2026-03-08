"""
backend/audio/pipeline.py

Playback state machine — owns MicCapture + PitchPipeline lifecycle.

States:
    STOPPED  → start()  → PLAYING
    PLAYING  → pause()  → PAUSED
    PAUSED   → resume() → PLAYING
    PLAYING  → stop()   → STOPPED
    PAUSED   → stop()   → STOPPED

The `t` timestamp in emitted frames is milliseconds since play was pressed.
This anchors to the same moment as AudioContext.currentTime = 0 on the frontend.
"""

from __future__ import annotations

import asyncio
import logging
import time
import threading
from enum import Enum, auto

from .capture import MicCapture
from .pitch import PitchFrame, PitchPipeline, Engine, select_engine

log = logging.getLogger(__name__)


# ── State machine ──────────────────────────────────────────────────────────────


class PlaybackState(Enum):
    STOPPED = auto()
    PLAYING = auto()
    PAUSED = auto()


# ── Pipeline manager ───────────────────────────────────────────────────────────


class PlaybackPipeline:
    """
    Manages the full capture → pitch detection → WebSocket emit chain.

    One instance lives on the FastAPI app for the duration of the process.
    Thread-safe: REST endpoints call state-changing methods from async handlers;
    pitch frames arrive from the pitch worker thread.

    Usage (from FastAPI):
        pipeline = PlaybackPipeline()

        # wire up at startup
        app.state.pipeline = pipeline

        # REST endpoints call:
        pipeline.start(device_id=9, loop=asyncio.get_event_loop())
        pipeline.pause()
        pipeline.resume()
        pipeline.stop()

        # WebSocket handler registers/deregisters itself:
        pipeline.add_client(queue)
        pipeline.remove_client(queue)
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or select_engine()
        self._lock = threading.Lock()
        self._state = PlaybackState.STOPPED

        # Timing
        self._play_monotonic: float = 0.0   # time.monotonic() at last play/resume
        self._elapsed_ms: float = 0.0       # accumulated ms before last pause

        # Hardware objects — created on start, destroyed on stop
        self._capture: MicCapture | None = None
        self._pitch: PitchPipeline | None = None

        # Async event loop — set when start() is called from an async context
        self._loop: asyncio.AbstractEventLoop | None = None

        # Connected WebSocket client queues
        self._clients: set[asyncio.Queue] = set()
        self._clients_lock = threading.Lock()

    # ── Public API (called from REST endpoints) ────────────────────────────────

    def start(
        self,
        device_id: int | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        with self._lock:
            if self._state == PlaybackState.PLAYING:
                return
            if self._state == PlaybackState.PAUSED:
                self._resume_locked()
                return

            # STOPPED → PLAYING
            self._loop = loop
            self._elapsed_ms = 0.0
            self._play_monotonic = time.monotonic()

            self._pitch = PitchPipeline(
                engine=self._engine,
                on_frame=self._on_pitch_frame,
            )
            self._capture = MicCapture(
                device_id=device_id,
                on_window=self._pitch.push,
            )

            self._pitch.start()
            self._capture.start()
            self._state = PlaybackState.PLAYING
            log.info("PlaybackPipeline started — device=%s engine=%s", device_id, self._engine.name)

    def pause(self) -> None:
        with self._lock:
            if self._state != PlaybackState.PLAYING:
                return
            # Accumulate elapsed time before suspending capture
            self._elapsed_ms += (time.monotonic() - self._play_monotonic) * 1000.0
            if self._capture:
                self._capture.stop()
            self._state = PlaybackState.PAUSED
            log.info("PlaybackPipeline paused at t=%.1f ms", self._elapsed_ms)

    def resume(self) -> None:
        with self._lock:
            if self._state != PlaybackState.PAUSED:
                return
            self._resume_locked()

    def stop(self) -> None:
        with self._lock:
            if self._state == PlaybackState.STOPPED:
                return
            self._teardown_locked()
            self._elapsed_ms = 0.0
            self._state = PlaybackState.STOPPED
            log.info("PlaybackPipeline stopped")

    @property
    def state(self) -> PlaybackState:
        with self._lock:
            return self._state

    @property
    def elapsed_ms(self) -> float:
        """Current playback position in ms. Safe to call from any thread."""
        with self._lock:
            if self._state == PlaybackState.PLAYING:
                return self._elapsed_ms + (time.monotonic() - self._play_monotonic) * 1000.0
            return self._elapsed_ms

    # ── WebSocket client management ────────────────────────────────────────────

    def add_client(self, q: asyncio.Queue) -> None:
        with self._clients_lock:
            self._clients.add(q)
        log.debug("WS client added (%d total)", len(self._clients))

    def remove_client(self, q: asyncio.Queue) -> None:
        with self._clients_lock:
            self._clients.discard(q)
        log.debug("WS client removed (%d total)", len(self._clients))

    # ── Internal ───────────────────────────────────────────────────────────────

    def _resume_locked(self) -> None:
        """Must be called with self._lock held."""
        self._play_monotonic = time.monotonic()
        if self._capture:
            self._capture.start()
        self._state = PlaybackState.PLAYING
        log.info("PlaybackPipeline resumed at t=%.1f ms", self._elapsed_ms)

    def _teardown_locked(self) -> None:
        """Stop capture and pitch pipeline. Must be called with self._lock held."""
        if self._capture:
            self._capture.stop()
            self._capture = None
        if self._pitch:
            self._pitch.stop()
            self._pitch = None

    def _on_pitch_frame(self, frame: PitchFrame) -> None:
        """
        Called from the pitch worker thread when a frame is ready.
        Computes t relative to play-start and fans out to all WS clients.
        """
        with self._lock:
            if self._state != PlaybackState.PLAYING:
                return
            t_ms = self._elapsed_ms + (time.monotonic() - self._play_monotonic) * 1000.0

        payload = {
            "t": round(t_ms, 1),
            "midi": round(frame.midi, 3),
            "conf": round(frame.confidence, 3),
        }

        # Fan out to all connected WebSocket clients via their asyncio queues
        loop = self._loop
        if loop is None or not loop.is_running():
            return

        with self._clients_lock:
            clients = list(self._clients)

        for q in clients:
            try:
                loop.call_soon_threadsafe(q.put_nowait, payload)
            except Exception:
                pass  # client may have disconnected — harmless
