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
    # Force _loop to None in case a loop is already running in the test process.
    pipeline._loop = None  # noqa: SLF001

    q: asyncio.Queue = asyncio.Queue()
    # Patch get_running_loop to simulate no running loop — exercises the
    # RuntimeError branch in add_client.
    import unittest.mock as mock

    with mock.patch("backend.audio.pipeline.asyncio.get_running_loop", side_effect=RuntimeError):
        pipeline.add_client(q)

    assert pipeline._loop is None  # noqa: SLF001
    pipeline.remove_client(q)


def test_fan_out_suppresses_exception_from_bad_queue() -> None:
    """_fan_out_payload must not propagate if a client queue's put_nowait raises."""
    pipeline = PlaybackPipeline(engine=Engine.PYIN)

    q: asyncio.Queue = asyncio.Queue()
    pipeline.add_client(q)

    # Build a mock loop that is "running" and captures call_soon_threadsafe calls.
    mock_loop = MagicMock()
    mock_loop.is_running.return_value = True
    captured_callbacks: list = []

    def _capture(cb, *args):
        captured_callbacks.append((cb, args))

    mock_loop.call_soon_threadsafe.side_effect = _capture

    # Inject mock loop AFTER add_client so it overrides whatever loop was set.
    pipeline._loop = mock_loop  # noqa: SLF001

    pipeline.inject_frame(t_ms=1.0, midi=60.0, conf=0.9)

    assert len(captured_callbacks) == 1, "Expected one call_soon_threadsafe call"

    # Now execute the scheduled callback with a raising put_nowait — exercises
    # the bare `except Exception: pass` branch in _fan_out_payload.
    cb, args = captured_callbacks[0]
    original_put = q.put_nowait
    q.put_nowait = MagicMock(side_effect=RuntimeError("simulated bad queue"))
    try:
        cb(*args)
    except Exception:  # noqa: BLE001
        pytest.fail("_fan_out_payload did not suppress the exception from put_nowait")
    finally:
        q.put_nowait = original_put

    pipeline.remove_client(q)
