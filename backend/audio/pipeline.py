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
from .pitch import PitchFrame, PitchPipeline, Engine, resolve_engine_runtime

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

# WebSocket client queue depth. At ~20Hz a full queue means >3s of backlog —
# the client is hopelessly behind and frames should be dropped rather than block.
_CLIENT_QUEUE_MAXSIZE = 64

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
        self._force_cpu = False
        self._runtime_info = resolve_engine_runtime()
        self._engine = engine or self._runtime_info.engine
        self._lock = threading.Lock()
        self._state = PlaybackState.STOPPED

        # Timing
        self._play_monotonic: float = 0.0   # time.monotonic() at last play/resume
        self._elapsed_ms: float = 0.0       # accumulated ms before last pause
        self._tempo_multiplier: float = 1.0

        # Transposition — semitones offset kept in sync with the frontend Web Audio
        # detune value; used by the pitch interpretation layer (Day 9) to shift
        # expected MIDI targets when comparing detected f0 against score notes.
        self._transpose_semitones: int = 0

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
                # Resume from pause — reuse existing hardware, do not reinitialise
                self._resume_locked()
                return  # ← must return; hardware already exists

            # STOPPED → PLAYING
            self._loop = loop
            self._elapsed_ms = 0.0
            self._tempo_multiplier = 1.0
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
            self._elapsed_ms += (time.monotonic() - self._play_monotonic) * 1000.0 * self._tempo_multiplier
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
            self._tempo_multiplier = 1.0
            self._state = PlaybackState.STOPPED
            log.info("PlaybackPipeline stopped")


    def seek(self, t_ms: float) -> None:
        with self._lock:
            if self._state == PlaybackState.STOPPED:
                return
            self._elapsed_ms = max(0.0, t_ms)
            if self._state == PlaybackState.PLAYING:
                self._play_monotonic = time.monotonic()
            log.info("PlaybackPipeline seeked to t=%.1f ms (state=%s)", self._elapsed_ms, self._state.name)


    def set_transpose_semitones(self, semitones: int) -> None:
        """Set the active transposition offset in semitones (clamped to ±12)."""
        with self._lock:
            self._transpose_semitones = max(-12, min(12, int(semitones)))
            log.info("PlaybackPipeline transpose set to %d semitones", self._transpose_semitones)

    @property
    def transpose_semitones(self) -> int:
        with self._lock:
            return self._transpose_semitones

    @property
    def engine(self) -> Engine:
        return self._engine


    @property
    def runtime_info(self):
        return self._runtime_info

    @property
    def force_cpu(self) -> bool:
        return self._force_cpu

    def set_force_cpu(self, enabled: bool) -> None:
        with self._lock:
            self._force_cpu = bool(enabled)
            self._runtime_info = resolve_engine_runtime(force_cpu=self._force_cpu)
            self._engine = self._runtime_info.engine
            was_running = self._state != PlaybackState.STOPPED
            current_state = self._state
            if was_running:
                device_id = self._capture.device_id if self._capture else None
                self._teardown_locked()
                self._pitch = PitchPipeline(
                    engine=self._engine,
                    on_frame=self._on_pitch_frame,
                )
                self._capture = MicCapture(
                    device_id=device_id,
                    on_window=self._pitch.push,
                )
                self._pitch.start()
                if current_state == PlaybackState.PLAYING:
                    self._capture.start()
                self._state = current_state
            log.info(
                "PlaybackPipeline engine updated — engine=%s mode=%s device=%s",
                self._runtime_info.engine.name,
                self._runtime_info.mode,
                self._runtime_info.device,
            )

    def set_tempo_multiplier(self, multiplier: float) -> None:
        with self._lock:
            if multiplier <= 0:
                raise ValueError("multiplier must be > 0")

            if self._state == PlaybackState.PLAYING:
                self._elapsed_ms += (time.monotonic() - self._play_monotonic) * 1000.0 * self._tempo_multiplier
                self._play_monotonic = time.monotonic()

            self._tempo_multiplier = multiplier

    @property
    def tempo_multiplier(self) -> float:
        with self._lock:
            return self._tempo_multiplier

    @property
    def state(self) -> PlaybackState:
        with self._lock:
            return self._state

    @property
    def elapsed_ms(self) -> float:
        """Current playback position in ms. Safe to call from any thread."""
        with self._lock:
            if self._state == PlaybackState.PLAYING:
                return self._elapsed_ms + (time.monotonic() - self._play_monotonic) * 1000.0 * self._tempo_multiplier
            return self._elapsed_ms

    # ── WebSocket client management ────────────────────────────────────────────

    def add_client(self, q: asyncio.Queue) -> None:
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
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

            # Use the frame's capture timestamp to avoid adding inference/
            # queue latency to `t`. This keeps note matching aligned with
            # the audio that actually produced the detected pitch.
            play_anchor_ms = self._play_monotonic * 1000.0
            frame_elapsed_ms = max(0.0, frame.time_ms - play_anchor_ms)
            t_ms = self._elapsed_ms + (frame_elapsed_ms * self._tempo_multiplier)

        payload = {
            "t": round(t_ms, 1),
            "midi": round(frame.midi, 3),
            "conf": round(frame.confidence, 3),
        }

        self._fan_out_payload(payload)

    def inject_frame(self, *, t_ms: float, midi: float, conf: float) -> None:
        """Inject a synthetic frame payload for tests without touching internals."""
        payload = {
            "t": round(t_ms, 1),
            "midi": round(midi, 3),
            "conf": round(conf, 3),
        }
        self._fan_out_payload(payload)

    def _fan_out_payload(self, payload: dict[str, float]) -> None:
        """Send a frame payload to all connected WebSocket clients."""

        loop = self._loop
        if loop is None or not loop.is_running():
            return

        with self._clients_lock:
            clients = list(self._clients)

        for q in clients:
            try:
                loop.call_soon_threadsafe(q.put_nowait, payload)
            except asyncio.QueueFull:
                log.warning("WS client queue full — dropping frame (client too slow)")
            except Exception:
                pass  # client may have disconnected — harmless
