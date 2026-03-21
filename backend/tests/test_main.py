"""Tests for backend.main helpers."""

from pytest import MonkeyPatch

from backend.main import _parse_cors_origins


def test_parse_cors_origins_uses_defaults_when_env_missing(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("ELECTRON_MODE", raising=False)
    assert _parse_cors_origins(None) == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_parse_cors_origins_accepts_comma_separated_values(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("ELECTRON_MODE", raising=False)
    assert _parse_cors_origins("http://localhost:5173, https://app.example.com") == [
        "http://localhost:5173",
        "https://app.example.com",
    ]


def test_parse_cors_origins_falls_back_when_env_is_blank(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("ELECTRON_MODE", raising=False)
    assert _parse_cors_origins(" ,   ") == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_parse_cors_origins_uses_wildcard_in_electron_mode(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("ELECTRON_MODE", "1")
    assert _parse_cors_origins("https://app.example.com") == ["*"]


def test_parse_cors_origins_electron_mode_overrides_configured_origins(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("ELECTRON_MODE", "true")
    raw_origins = "https://app.example.com"
    monkeypatch.setenv("CORS_ORIGINS", raw_origins)
    assert _parse_cors_origins(raw_origins) == ["*"]


def test_parse_cors_origins_blank_settings_still_allow_electron(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("ELECTRON_MODE", "yes")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    assert _parse_cors_origins(None) == ["*"]
