"""Session persistence helpers for recording/review workflows."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

SESSIONS_DIR = Path(os.environ.get("SING_ATTUNE_SESSIONS_DIR", Path(__file__).resolve().parents[2] / "data" / "sessions"))


def _slug(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip())
    sanitized = sanitized.strip("_")
    return sanitized or "session"


def _ensure_dir() -> Path:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    return SESSIONS_DIR


def build_session_filename(title: str, part: str, now: datetime | None = None) -> str:
    timestamp = (now or datetime.now(tz=timezone.utc)).strftime("%Y%m%d_%H%M%S")
    return f"{_slug(title)}_{_slug(part)}_{timestamp}.json"


def save_session(payload: dict[str, Any]) -> tuple[str, Path]:
    directory = _ensure_dir()
    title = str(payload.get("title") or "session")
    part = str(payload.get("part") or "part")
    filename = build_session_filename(title, part)
    path = directory / filename
    if path.exists():
        path = directory / f"{path.stem}_{uuid4().hex[:8]}.json"

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return path.stem, path


def read_session(session_id: str) -> dict[str, Any]:
    path = _ensure_dir() / f"{session_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Session '{session_id}' not found")

    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def list_sessions() -> list[dict[str, Any]]:
    directory = _ensure_dir()
    sessions: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with path.open("r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue

        frames = payload.get("frames") if isinstance(payload, dict) else None
        frame_count = len(frames) if isinstance(frames, list) else 0
        sessions.append(
            {
                "id": path.stem,
                "title": payload.get("title", ""),
                "part": payload.get("part", ""),
                "created_at": payload.get("created_at", datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()),
                "frame_count": frame_count,
            }
        )
    return sessions

