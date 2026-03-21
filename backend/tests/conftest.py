"""
backend/tests/conftest.py

Pytest configuration for sing-attune backend tests.

Markers:
  hardware — tests that require real audio hardware (mic, speakers).
             Automatically skipped in CI where no audio devices exist.
             Run locally with: uv run pytest -m hardware

  gpu      — tests that additionally require a CUDA-capable GPU.
             Automatically skipped in CI.
             Run locally with: uv run pytest -m gpu

CI detection: the GITHUB_ACTIONS environment variable is set by GitHub Actions.
"""

import os
import sys
import types

import pytest


def _ensure_sounddevice_stub() -> None:
    try:
        import sounddevice  # noqa: F401
        return
    except (ModuleNotFoundError, OSError):
        pass

    stub = types.ModuleType("sounddevice")

    class PortAudioError(Exception):
        pass

    class CallbackFlags:
        pass

    class InputStream:
        def __init__(self, *args, **kwargs):
            self.active = False

        def start(self) -> None:
            self.active = True

        def stop(self) -> None:
            self.active = False

        def close(self) -> None:
            self.active = False

    def query_hostapis() -> list[dict[str, str]]:
        return []

    def query_devices(kind=None):
        if kind == "input":
            raise PortAudioError("No input devices")
        return []

    stub.PortAudioError = PortAudioError
    stub.CallbackFlags = CallbackFlags
    stub.InputStream = InputStream
    stub.query_hostapis = query_hostapis
    stub.query_devices = query_devices
    sys.modules["sounddevice"] = stub


def _ensure_torch_stub() -> None:
    try:
        import torch  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("torch")

    class Tensor:
        pass

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def get_device_name(_index: int) -> str:
            return "CPU"

    class _NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    stub.Tensor = Tensor
    stub.cuda = _Cuda()
    stub.device = lambda name: name
    stub.no_grad = lambda: _NoGrad()
    stub.from_numpy = lambda arr: arr
    sys.modules["torch"] = stub


_ensure_sounddevice_stub()
_ensure_torch_stub()


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "hardware: mark test as requiring real audio hardware — skipped in CI",
    )
    config.addinivalue_line(
        "markers",
        "gpu: mark test as requiring a CUDA-capable GPU — skipped in CI",
    )


def pytest_collection_modifyitems(config, items):
    """Auto-skip environment-dependent tests when dependencies are unavailable."""
    import sounddevice as sd
    import torch

    skip_hardware = None
    try:
        has_input_device = bool(sd.query_devices()) and _default_input_available(sd)
    except Exception:
        has_input_device = False
    if os.environ.get("GITHUB_ACTIONS") or not has_input_device:
        skip_hardware = pytest.mark.skip(reason="hardware tests skipped (no audio devices in this environment)")

    skip_gpu = None
    if os.environ.get("GITHUB_ACTIONS") or not torch.cuda.is_available():
        skip_gpu = pytest.mark.skip(reason="gpu tests skipped (no CUDA device in this environment)")

    for item in items:
        if skip_hardware and "hardware" in item.keywords:
            item.add_marker(skip_hardware)
        if skip_gpu and "gpu" in item.keywords:
            item.add_marker(skip_gpu)


def _default_input_available(sd) -> bool:
    try:
        return sd.query_devices(kind="input") is not None
    except Exception:
        return False
