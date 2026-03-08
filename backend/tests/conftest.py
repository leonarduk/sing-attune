"""
backend/tests/conftest.py

Pytest configuration for sing-attune backend tests.

Markers:
  hardware — tests that require real audio hardware (mic, speakers).
             Automatically skipped in CI where no audio devices exist.
             Run locally with: uv run pytest -m hardware

CI detection: the GITHUB_ACTIONS environment variable is set by GitHub Actions.
"""

import os
import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "hardware: mark test as requiring real audio hardware — skipped in CI",
    )


def pytest_collection_modifyitems(config, items):
    """Auto-skip hardware tests when running in CI (GITHUB_ACTIONS is set)."""
    if not os.environ.get("GITHUB_ACTIONS"):
        return  # running locally — let hardware tests run normally

    skip_hardware = pytest.mark.skip(reason="hardware tests skipped in CI (no audio devices)")
    for item in items:
        if "hardware" in item.keywords:
            item.add_marker(skip_hardware)
