"""Tests for backend.main helpers."""

from backend.main import _parse_cors_origins


def test_parse_cors_origins_uses_defaults_when_env_missing() -> None:
    assert _parse_cors_origins(None) == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_parse_cors_origins_accepts_comma_separated_values() -> None:
    assert _parse_cors_origins("http://localhost:5173, https://app.example.com") == [
        "http://localhost:5173",
        "https://app.example.com",
    ]


def test_parse_cors_origins_falls_back_when_env_is_blank() -> None:
    assert _parse_cors_origins(" ,   ") == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
