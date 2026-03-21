"""Tests for session save/list/get endpoints."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient


def _client_with_tmp(monkeypatch, tmp: str) -> TestClient:
    """Return a TestClient with SESSIONS_DIR redirected to *tmp*."""
    monkeypatch.setenv("SING_ATTUNE_SESSIONS_DIR", tmp)
    from backend.main import app
    from backend.session import store
    store.SESSIONS_DIR = Path(tmp)
    return TestClient(app)


def test_session_save_list_get(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        client = _client_with_tmp(monkeypatch, tmp)

        payload = {
            "title": "Homeward Bound",
            "part": "Tenor",
            "created_at": "2026-03-15T10:00:00Z",
            "frames": [
                {"t": 10, "beat": 0.1, "midi": 60.1, "conf": 0.9, "expected_midi": 60, "measure": 1},
            ],
        }

        save = client.post("/session/save", json=payload)
        assert save.status_code == 200
        session_id = save.json()["id"]

        listing = client.get("/session/list")
        assert listing.status_code == 200
        sessions = listing.json()["sessions"]
        assert len(sessions) == 1
        assert sessions[0]["id"] == session_id

        detail = client.get(f"/session/{session_id}")
        assert detail.status_code == 200
        assert detail.json()["title"] == "Homeward Bound"
        assert len(detail.json()["frames"]) == 1


def test_session_save_openapi_schema_uses_typed_request_model() -> None:
    """OpenAPI must expose SessionSaveRequest as the /session/save request body schema."""
    from backend.main import app

    schema = app.openapi()
    request_body = schema["paths"]["/session/save"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    assert request_body == {"$ref": "#/components/schemas/SessionSaveRequest"}


def test_session_get_missing_returns_404() -> None:
    from backend.main import app
    client = TestClient(app)
    response = client.get("/session/does-not-exist")
    assert response.status_code == 404


def test_session_save_missing_frames_returns_422(monkeypatch) -> None:
    """POST /session/save must reject payloads missing the required frames list."""
    with tempfile.TemporaryDirectory() as tmp:
        client = _client_with_tmp(monkeypatch, tmp)
        response = client.post("/session/save", json={"title": "Song", "part": "Tenor"})
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any(error["loc"] == ["body", "frames"] for error in detail)


def test_session_save_null_optional_frame_fields(monkeypatch) -> None:
    """Frames with null midi/expected_midi/measure must be stored as None."""
    with tempfile.TemporaryDirectory() as tmp:
        client = _client_with_tmp(monkeypatch, tmp)
        payload = {
            "title": "Song",
            "part": "Bass",
            "frames": [
                {"t": 0.0, "beat": 0.0, "midi": None, "conf": 0.1,
                 "expected_midi": None, "measure": None},
            ],
        }
        save = client.post("/session/save", json=payload)
        assert save.status_code == 200
        session_id = save.json()["id"]

        detail = client.get(f"/session/{session_id}")
        assert detail.status_code == 200
        frame = detail.json()["frames"][0]
        assert frame["midi"] is None
        assert frame["expected_midi"] is None
        assert frame["measure"] is None


def test_session_save_conf_out_of_range_returns_422(monkeypatch) -> None:
    """Frame confidence outside 0.0-1.0 must be rejected by request validation."""
    with tempfile.TemporaryDirectory() as tmp:
        client = _client_with_tmp(monkeypatch, tmp)
        payload = {
            "title": "Song",
            "part": "Alto",
            "frames": [
                {"t": 1.0, "beat": 0.5, "midi": 62.0, "conf": 1.5,
                 "expected_midi": 62, "measure": 2},
            ],
        }
        response = client.post("/session/save", json=payload)
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any(error["loc"] == ["body", "frames", 0, "conf"] for error in detail)


# ── store.py unit tests ────────────────────────────────────────────────────────


def test_slug_all_punctuation_returns_session_fallback() -> None:
    """_slug() with an all-punctuation string must return 'session'."""
    from backend.session.store import _slug
    assert _slug("---!!!") == "session"


def test_save_session_collision_appends_uuid_suffix(monkeypatch) -> None:
    """save_session() must append a UUID suffix when filename already exists."""
    with tempfile.TemporaryDirectory() as tmp:
        from backend.session import store
        store.SESSIONS_DIR = Path(tmp)

        payload = {
            "title": "Song",
            "part": "Soprano",
            "created_at": "2026-01-01T00:00:00Z",
            "frames": [],
        }

        # Freeze the filename by fixing datetime.now()
        from datetime import datetime, timezone
        fixed_now = datetime(2026, 1, 1, tzinfo=timezone.utc)

        import backend.session.store as store_module
        original_build = store_module.build_session_filename

        def fixed_filename(title: str, part: str, now=None) -> str:
            return original_build(title, part, now=fixed_now)

        monkeypatch.setattr(store_module, "build_session_filename", fixed_filename)

        id1, path1 = store.save_session(payload)
        id2, path2 = store.save_session(payload)

        assert path1 != path2, "Second save must use a different path"
        assert path1.exists()
        assert path2.exists()
        # The second file should have a UUID-style suffix
        assert path2.stem.startswith(path1.stem)


def test_list_sessions_skips_corrupt_files(monkeypatch) -> None:
    """list_sessions() must silently skip files that are not valid JSON."""
    with tempfile.TemporaryDirectory() as tmp:
        from backend.session import store
        store.SESSIONS_DIR = Path(tmp)

        # Write a valid session
        valid = Path(tmp) / "valid_session_20260101_000000.json"
        valid.write_text(
            json.dumps({"title": "Good", "part": "Tenor", "frames": []}),
            encoding="utf-8",
        )

        # Write a corrupt file
        corrupt = Path(tmp) / "corrupt_session_20260101_000001.json"
        corrupt.write_text("not valid json{{{", encoding="utf-8")

        sessions = store.list_sessions()
        # Only the valid file should appear
        assert len(sessions) == 1
        assert sessions[0]["title"] == "Good"
