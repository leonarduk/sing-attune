import importlib


def _load_main_module(monkeypatch, **env):
    for key in ("CORS_ORIGINS", "ELECTRON_MODE"):
        monkeypatch.delenv(key, raising=False)

    for key, value in env.items():
        monkeypatch.setenv(key, value)

    import backend.main as backend_main

    return importlib.reload(backend_main)


def test_default_cors_origins_preserve_existing_behavior(monkeypatch):
    backend_main = _load_main_module(monkeypatch)

    assert backend_main._parse_cors_origins(None) == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    assert backend_main._cors_settings_from_env() == {
        "allow_origins": [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        "allow_credentials": True,
    }



def test_cors_origins_env_var_overrides_defaults(monkeypatch):
    backend_main = _load_main_module(
        monkeypatch,
        CORS_ORIGINS="http://localhost:4173, https://example.com , ,http://127.0.0.1:3000",
    )

    assert backend_main._cors_settings_from_env() == {
        "allow_origins": [
            "http://localhost:4173",
            "https://example.com",
            "http://127.0.0.1:3000",
        ],
        "allow_credentials": True,
    }



def test_empty_cors_origins_env_var_falls_back_to_defaults(monkeypatch):
    backend_main = _load_main_module(monkeypatch, CORS_ORIGINS=" , ")

    assert backend_main._cors_settings_from_env()["allow_origins"] == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]



def test_electron_mode_uses_wildcard_without_credentials(monkeypatch):
    backend_main = _load_main_module(
        monkeypatch,
        ELECTRON_MODE="1",
        CORS_ORIGINS="https://should-not-be-used.example",
    )

    assert backend_main._cors_settings_from_env() == {
        "allow_origins": ["*"],
        "allow_credentials": False,
    }
