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
import threading
import time
from enum import Enum, auto

from .capture import MicCapture
from .pitch import Engine, PitchFrame, PitchPipeline, resolve_engine_runtime
from .pitch_protocol import PitchFramePayload, encode_pitch_frame

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

        # Serializes the *whole* teardown-and-maybe-rebuild sequence of
        # stop()/set_force_cpu() against each other. `self._lock` above is
        # deliberately released for the blocking hardware.stop()/.join()
        # part of that sequence (see stop()/set_force_cpu()/_teardown_hardware
        # for why — #425), which means two racing calls could otherwise
        # interleave their steps: e.g. one call's set_force_cpu() rebuild
        # could resurrect hardware that a concurrent stop() just tore down,
        # or two racing set_force_cpu() calls could each rebuild from a
        # stale device_id and leak the loser's freshly-started MicCapture/
        # PitchPipeline. This lock is never acquired by the pitch worker
        # thread (only `self._lock` is), so it cannot reintroduce the
        # worker-vs-event-loop contention this issue fixes.
        #
        # pause()/resume() deliberately do NOT take this lock (only
        # `self._lock`, briefly). They're called synchronously from `async
        # def` REST handlers same as stop()/set_force_cpu() (#425), so
        # blocking one on a lock held across the other's multi-second
        # teardown/rebuild would stall the whole asyncio event loop — the
        # exact hazard #425 fixed, just moved to a different method. Instead,
        # set_force_cpu()'s rebuild phase re-reads self._state after
        # re-acquiring self._lock rather than trusting a pre-teardown
        # snapshot, so it can never clobber a pause()/resume() that ran
        # during its unlocked gap (#571). See set_force_cpu()'s rebuild
        # phase and pause()'s `if self._capture:` guard for the details.
        self._lifecycle_lock = threading.Lock()

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
                on_engine_failure=self._on_pitch_engine_failure,
            )
            self._capture = MicCapture(
                device_id=device_id,
                on_window=self._pitch.push,
            )

            try:
                self._pitch.start()
                self._capture.start()
            except Exception:
                # self._pitch/self._capture are assigned above before either
                # .start() runs, so a failure here (e.g. MicCapture.start()
                # raising on an invalid/busy device_id from
                # POST /playback/start?device_id=) can leave one of them
                # already live — e.g. the pitch worker thread running —
                # while state is still STOPPED. Without tearing down here,
                # the next start() call retakes this same branch and
                # overwrites both references, permanently orphaning the
                # leaked thread/stream (issue #424). _teardown_hardware()
                # is a no-op for whichever side never started; unlike
                # stop()/set_force_cpu() (#425) it's called here with
                # self._lock still held. That's only safe because nothing
                # on the other side of PitchPipeline.stop()'s thread.join()
                # could be blocked wanting self._lock: MicCapture.start()
                # opens and starts the PortAudio stream *synchronously* —
                # if it raises (the only way this except block is reached
                # once self._pitch.start() has already succeeded), that
                # stream's audio callback, the sole caller of
                # pitch.push(), has never fired even once. The pitch
                # worker's queue is therefore empty; it's idling on
                # queue.get(), not inside _on_pitch_frame() wanting the
                # lock. (Raised and confirmed during AI review of the
                # #425/#446 merge, PR #472.)
                self._teardown_hardware(self._capture, self._pitch)
                self._capture = None
                self._pitch = None
                raise
            self._state = PlaybackState.PLAYING
            log.info("PlaybackPipeline started — device=%s engine=%s", device_id, self._engine.name)

    def pause(self) -> None:
        with self._lock:
            if self._state != PlaybackState.PLAYING:
                return
            # self._capture can be None here even though self._state is still
            # PLAYING: set_force_cpu() detaches self._capture/self._pitch and
            # releases self._lock *before* its blocking hardware teardown
            # (#425), without touching self._state until it rebuilds. If
            # pause() lands in that gap, self._elapsed_ms was already frozen
            # by set_force_cpu()'s own accumulation off this same,
            # not-yet-reset self._play_monotonic at the moment it detached —
            # accumulating again here would double-count the *entire*
            # playing duration since the last play/resume, not just the
            # small race window (#571). Gate on self._capture — the same
            # condition already guarding the .stop() call below — so the
            # redundant add is skipped precisely when set_force_cpu() has
            # already accounted for this stretch of time.
            if self._capture:
                self._elapsed_ms += (time.monotonic() - self._play_monotonic) * 1000.0 * self._tempo_multiplier
                self._capture.stop()
            self._state = PlaybackState.PAUSED
            log.info("PlaybackPipeline paused at t=%.1f ms", self._elapsed_ms)

    def resume(self) -> None:
        with self._lock:
            if self._state != PlaybackState.PAUSED:
                return
            self._resume_locked()

    def stop(self) -> None:
        # #425: stop() and set_force_cpu() must never hold `self._lock`
        # while blocking on hardware teardown (PitchPipeline.stop() calls
        # `self._thread.join(timeout=2.0)`). If a window is still queued
        # when that runs, the worker thread processes it first and calls
        # `_on_pitch_frame()`, which itself needs `self._lock` — so a
        # version of this method that held the lock across the join would
        # make the worker block on that acquire, and `.join()` wouldn't
        # return until the full 2s timeout elapsed. Since REST handlers
        # call stop()/set_force_cpu() synchronously (no `await`) from
        # `async def` endpoints, that stall would freeze the entire
        # asyncio event loop — every WS ping and REST request — for up to
        # 2s. Fix: snapshot+detach the hardware handles and finalize all
        # state changes *while holding the lock*, release it, and only
        # then call the blocking .stop() methods on the (now unshared)
        # local references. `_lifecycle_lock` serializes this whole
        # sequence against a racing set_force_cpu()/stop() call; see its
        # docstring in __init__ for why that's needed in addition to the
        # (short, non-blocking) `self._lock` critical sections below.
        with self._lifecycle_lock:
            with self._lock:
                if self._state == PlaybackState.STOPPED:
                    return
                capture, pitch = self._capture, self._pitch
                self._capture = None
                self._pitch = None
                self._elapsed_ms = 0.0
                self._tempo_multiplier = 1.0
                self._state = PlaybackState.STOPPED

            # Outside `self._lock` — see comment above and _teardown_hardware.
            self._teardown_hardware(capture, pitch)
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

    @property
    def xrun_count(self) -> int:
        with self._lock:
            if self._capture is None:
                return 0
            return self._capture.xrun_count

    def set_force_cpu(self, enabled: bool) -> None:
        # #425: same lock-across-join hazard as stop() (see its comment) —
        # the old code held `self._lock` through `_teardown_locked()`,
        # which blocks on the pitch worker thread's `.join()` while that
        # worker may itself be blocked wanting `self._lock` inside
        # `_on_pitch_frame()`. Fix here follows the same two-phase shape:
        # detach the old hardware under the lock, tear it down (blocking)
        # with the lock released, then re-acquire the lock to build and
        # attach the replacement hardware. `_lifecycle_lock` wraps the
        # entire method so a racing stop()/set_force_cpu() call can't
        # interleave with this rebuild (e.g. resurrecting hardware a
        # concurrent stop() just tore down, or losing this call's
        # device_id/engine choice to another racing set_force_cpu()).
        with self._lifecycle_lock:
            with self._lock:
                enabled = bool(enabled)
                if enabled == self._force_cpu:
                    # No-op guard. There are now two independent callers that
                    # can both request force_cpu=True around the same time:
                    # the manual /audio/engine/force-cpu override, and the
                    # automatic GPU-failure fallback in
                    # _on_pitch_engine_failure (#427).
                    # _on_pitch_engine_failure checks force_cpu before
                    # dispatching its call here, but that check-then-act
                    # happens across threads (it runs on a freshly spawned
                    # thread specifically to avoid a self-join deadlock —
                    # see its docstring) and is therefore racy on its own.
                    # Re-checking here, atomically under the same lock that
                    # performs the rebuild below, is what actually closes
                    # the race: a redundant call becomes a true no-op
                    # instead of an unnecessary capture/pitch teardown+
                    # rebuild. Flagged in PR review for #427.
                    return
                self._force_cpu = enabled
                self._runtime_info = resolve_engine_runtime(force_cpu=self._force_cpu)
                self._engine = self._runtime_info.engine
                was_running = self._state != PlaybackState.STOPPED
                current_state = self._state
                device_id = None
                old_capture, old_pitch = None, None
                if was_running:
                    device_id = self._capture.device_id if self._capture else None
                    # Snapshot elapsed time before teardown so we can restore it.
                    # This is what makes pause()'s `if self._capture:` guard
                    # (#571) correct: a pause() that lands after self._capture
                    # is nulled below sees the stretch of time already
                    # accounted for here and skips re-accumulating it.
                    if current_state == PlaybackState.PLAYING:
                        self._elapsed_ms += (
                            (time.monotonic() - self._play_monotonic)
                            * 1000.0
                            * self._tempo_multiplier
                        )
                    old_capture, old_pitch = self._capture, self._pitch
                    self._capture = None
                    self._pitch = None

            # Outside `self._lock` — see comment above and _teardown_hardware.
            if was_running:
                self._teardown_hardware(old_capture, old_pitch)

            with self._lock:
                if was_running:
                    self._pitch = PitchPipeline(
                        engine=self._engine,
                        on_frame=self._on_pitch_frame,
                        on_engine_failure=self._on_pitch_engine_failure,
                    )
                    self._capture = MicCapture(
                        device_id=device_id,
                        on_window=self._pitch.push,
                    )
                    self._pitch.start()
                    # Re-read self._state instead of trusting the
                    # `current_state` snapshot taken before the lock was
                    # released above. pause()/resume() only take self._lock,
                    # not `_lifecycle_lock` (see its docstring in __init__),
                    # so either can run to completion during the unlocked
                    # teardown gap. self._state is never written during the
                    # detach phase, so it's guaranteed to still be PLAYING or
                    # PAUSED here — the only state was_running started from,
                    # and the only transition pause()/resume() can make
                    # between them. Blindly restoring `current_state` (and
                    # unconditionally overwriting self._state with it below)
                    # used to silently discard whatever a racing
                    # pause()/resume() call had just decided: e.g.
                    # resurrecting capture right after the user paused, or
                    # leaving a resume() stuck with capture never actually
                    # started (#571).
                    if self._state == PlaybackState.PLAYING:
                        self._capture.start()
                        # Reset the play anchor so elapsed_ms continues smoothly.
                        self._play_monotonic = time.monotonic()
                    # self._state already holds the right value — either the
                    # untouched `current_state` (no race) or whatever a
                    # racing pause()/resume() set it to — so it's
                    # deliberately NOT overwritten here.
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

    def _teardown_hardware(
        self, capture: MicCapture | None, pitch: PitchPipeline | None
    ) -> None:
        """
        Stop the given (already-detached) capture/pitch objects.

        Must be called WITHOUT `self._lock` held (#425), unless the caller
        can prove nothing could be contending for it — see the comment at
        `start()`'s except block, the one caller that's an exception to
        this. `capture`/`pitch` are local references the caller already
        removed from `self._capture`/`self._pitch` under the lock (or, for
        `start()`'s failure path, is about to null right after calling
        this), so calling this outside the lock is safe even under
        concurrent stop()/set_force_cpu() calls — nobody else can reach
        these specific objects anymore.

        `PitchPipeline.stop()` calls `self._thread.join(timeout=2.0)`, and
        if the worker still has a window queued, it must run one more
        `_on_pitch_frame()` (which acquires `self._lock`) before it can
        reach the stop sentinel and let the thread exit. If `self._lock`
        were held here, the worker would block on that acquire and
        `.join()` would stall for the full 2s timeout instead of returning
        as soon as the worker drains — see stop()/set_force_cpu() for the
        full write-up.

        Each .stop() is also guarded independently (#446): a real
        PortAudio stream that was opened but never fully started (a
        plausible state after MicCapture.start() fails partway, see #424)
        can raise from .stop() itself. Without a guard, that exception
        would propagate out of here and mask whatever error the caller is
        already handling, and a failure stopping one object would prevent
        the other from being torn down. Note this function no longer owns
        resetting self._capture/self._pitch to None — every caller now
        does that itself (stop()/set_force_cpu() do it *before* calling
        this, as part of detaching; start()'s except block does it right
        after), so a raise here can no longer leave a stale self.*
        reference behind either way.
        """
        if capture:
            try:
                capture.stop()
            except Exception:
                log.exception("Error stopping MicCapture during teardown")
        if pitch:
            try:
                pitch.stop()
            except Exception:
                log.exception("Error stopping PitchPipeline during teardown")

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

        payload = encode_pitch_frame(t_ms=t_ms, midi=frame.midi, confidence=frame.confidence)

        self._fan_out_payload(payload)

    def _on_pitch_engine_failure(self) -> None:
        """
        Called from the pitch worker thread after PitchPipeline has seen
        _MAX_CONSECUTIVE_TORCHCREPE_FAILURES back-to-back GPU inference
        errors (issue #427 — e.g. CUDA context lost, VRAM exhausted).

        Reuses set_force_cpu(), the same hot-swap already used by the
        manual `/audio/engine/force-cpu` override, so the automatic
        fallback shows up "for free" in the existing /audio/engine
        response (active_engine/mode/force_cpu) with no bespoke signal.

        set_force_cpu() tears down PitchPipeline and joins its worker
        thread — but this callback runs *on* that same worker thread, and
        a thread cannot join itself (Python raises RuntimeError; some
        runtimes would deadlock). So the switch is dispatched onto a fresh,
        short-lived thread instead of calling set_force_cpu() inline here.
        """
        if self.force_cpu:
            return  # already on CPU — nothing to fall back to
        log.warning(
            "Automatic CPU fallback triggered after repeated GPU pitch-engine failures"
        )
        threading.Thread(
            target=lambda: self.set_force_cpu(True),
            daemon=True,
            name="pitch-engine-fallback",
        ).start()

    def inject_frame(self, *, t_ms: float, midi: float, conf: float) -> None:
        """Inject a synthetic frame payload for tests without touching internals."""
        payload = encode_pitch_frame(t_ms=t_ms, midi=midi, confidence=conf)
        self._fan_out_payload(payload)

    def _fan_out_payload(self, payload: PitchFramePayload) -> None:
        """Send a frame payload to all connected WebSocket clients."""

        loop = self._loop
        if loop is None or not loop.is_running():
            return

        with self._clients_lock:
            clients = list(self._clients)

        def _deliver(q: asyncio.Queue) -> None:
            # Runs on the event-loop thread when the scheduled callback actually
            # fires — NOT synchronously inside _fan_out_payload. call_soon_threadsafe
            # only *schedules* put_nowait; it returns immediately, before put_nowait
            # has run. So the try/except has to live in here, around the real call,
            # not around the call_soon_threadsafe(...) call below — otherwise
            # QueueFull raised by put_nowait surfaces later as an unhandled
            # callback exception instead of the intended log.warning (see #428).
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                log.warning("WS client queue full — dropping frame (client too slow)")
            except Exception:
                pass  # client may have disconnected — harmless

        for q in clients:
            try:
                loop.call_soon_threadsafe(_deliver, q)
            except Exception:
                pass  # loop may be closing (shutdown race) — harmless
