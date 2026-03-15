"""Integration tests for /ws/pitch handshake, keepalive, and frame contract."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import ExitStack

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
