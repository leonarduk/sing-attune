"""Tests for session save/list/get endpoints."""

from __future__ import annotations

import tempfile

from fastapi.testclient import TestClient


def test_session_save_list_get(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv('SING_ATTUNE_SESSIONS_DIR', tmp)

        from backend.main import app
        from backend.session import store

        from pathlib import Path
        store.SESSIONS_DIR = Path(tmp)

        client = TestClient(app)

        payload = {
            'title': 'Homeward Bound',
            'part': 'Tenor',
            'created_at': '2026-03-15T10:00:00Z',
            'frames': [
                {'t': 10, 'beat': 0.1, 'midi': 60.1, 'conf': 0.9, 'expected_midi': 60, 'measure': 1},
            ],
        }

        save = client.post('/session/save', json=payload)
        assert save.status_code == 200
        session_id = save.json()['id']

        listing = client.get('/session/list')
        assert listing.status_code == 200
        sessions = listing.json()['sessions']
        assert len(sessions) == 1
        assert sessions[0]['id'] == session_id

        detail = client.get(f'/session/{session_id}')
        assert detail.status_code == 200
        assert detail.json()['title'] == 'Homeward Bound'
        assert len(detail.json()['frames']) == 1


def test_session_get_missing_returns_404() -> None:
    from backend.main import app

    client = TestClient(app)
    response = client.get('/session/does-not-exist')
    assert response.status_code == 404
