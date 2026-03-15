"""Integration tests for /ws/pitch handshake, keepalive, and frame contract."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import ExitStack
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import backend.main as backend_main
from backend.audio.pipeline import PlaybackPipeline
from backend.audio.pitch import Engine


@pytest.fixture
def isolated_pipeline(monkeypatch: pytest.MonkeyPatch) -> PlaybackPipeline:
    pipeline = PlaybackPipeline(engine=Engine.PYIN)
    monkeypatch.setattr(backend_main, "_pipeline", pipeline)
    yield pipeline
    pipeline.stop()


@pytest.fixture
def client(isolated_pipeline: PlaybackPipeline) -> TestClient:
    with TestClient(backend_main.app) as test_client:
        yield test_client


def _receive_json_with_timeout(ws, timeout_s: float = 7.0):
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(ws.receive_json)
        try:
            return future.result(timeout=timeout_s)
        except FutureTimeoutError as exc:
            raise AssertionError(f"Timed out waiting for WebSocket message after {timeout_s}s") from exc


def test_ws_pitch_handshake_connected(client: TestClient) -> None:
    with client.websocket_connect("/ws/pitch") as ws:
        assert _receive_json_with_timeout(ws, timeout_s=2.0) == {"status": "connected"}


def test_ws_pitch_keepalive_ping_after_inactivity(client: TestClient) -> None:
    with client.websocket_connect("/ws/pitch") as ws:
        assert _receive_json_with_timeout(ws, timeout_s=2.0) == {"status": "connected"}
        assert _receive_json_with_timeout(ws, timeout_s=7.0) == {"ping": True}


def test_injected_frame_matches_payload_contract(
    client: TestClient,
    isolated_pipeline: PlaybackPipeline,
) -> None:
    with client.websocket_connect("/ws/pitch") as ws:
        assert _receive_json_with_timeout(ws, timeout_s=2.0) == {"status": "connected"}

        isolated_pipeline.inject_frame(t_ms=123.456, midi=60.12349, conf=0.98765)
        payload = _receive_json_with_timeout(ws, timeout_s=2.0)

    assert payload == {"t": 123.5, "midi": 60.123, "conf": 0.988}
    assert isinstance(payload["t"], float)
    assert isinstance(payload["midi"], float)
    assert isinstance(payload["conf"], float)


def test_injected_frame_fans_out_to_two_clients(
    client: TestClient,
    isolated_pipeline: PlaybackPipeline,
) -> None:
    with ExitStack() as stack:
        ws1 = stack.enter_context(client.websocket_connect("/ws/pitch"))
        ws2 = stack.enter_context(client.websocket_connect("/ws/pitch"))

        assert _receive_json_with_timeout(ws1, timeout_s=2.0) == {"status": "connected"}
        assert _receive_json_with_timeout(ws2, timeout_s=2.0) == {"status": "connected"}

        isolated_pipeline.inject_frame(t_ms=50.04, midi=61.9999, conf=0.5004)

        payload1 = _receive_json_with_timeout(ws1, timeout_s=2.0)
        payload2 = _receive_json_with_timeout(ws2, timeout_s=2.0)

    assert payload1 == {"t": 50.0, "midi": 62.0, "conf": 0.5}
    assert payload2 == payload1


def test_add_client_without_running_loop_is_safe() -> None:
    """add_client called outside any event loop must not raise; _loop stays None."""
    pipeline = PlaybackPipeline(engine=Engine.PYIN)
    assert pipeline._loop is None  # noqa: SLF001

    q: asyncio.Queue = asyncio.Queue()
    # No event loop is running in this synchronous context — the RuntimeError
    # branch in add_client must be swallowed and _loop must remain None.
    pipeline.add_client(q)

    assert pipeline._loop is None  # noqa: SLF001
    pipeline.remove_client(q)


def test_fan_out_suppresses_exception_from_bad_queue() -> None:
    """_fan_out_payload must not propagate if a client queue's put_nowait raises."""
    loop = asyncio.new_event_loop()
    try:
        pipeline = PlaybackPipeline(engine=Engine.PYIN)
        pipeline._loop = loop  # noqa: SLF001

        bad_queue = MagicMock(spec=asyncio.Queue)

        def _raise(*_args, **_kwargs):
            raise RuntimeError("simulated bad queue")

        # call_soon_threadsafe schedules the callback; we need it to actually run
        # and hit the except branch.  Run the callback synchronously via a real
        # loop so the exception fires inside _fan_out_payload's except clause.
        captured_callbacks: list = []

        def _capture(cb, *args):
            captured_callbacks.append((cb, args))

        loop.call_soon_threadsafe = _capture  # type: ignore[method-assign]

        pipeline.add_client(bad_queue)
        # inject_frame calls _fan_out_payload → call_soon_threadsafe captured above
        pipeline.inject_frame(t_ms=1.0, midi=60.0, conf=0.9)

        # Now execute the captured callback with a raising put_nowait to hit except
        assert len(captured_callbacks) == 1
        cb, args = captured_callbacks[0]
        bad_queue.put_nowait = _raise
        # Should not raise — exception must be suppressed
        try:
            cb(*args)
        except Exception:  # noqa: BLE001
            pytest.fail("_fan_out_payload did not suppress the exception")

        pipeline.remove_client(bad_queue)
    finally:
        loop.close()
