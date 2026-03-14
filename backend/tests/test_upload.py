"""Tests for uploaded score temp-file persistence."""

from __future__ import annotations

import io
import zipfile

import pytest
from fastapi import UploadFile

from backend.score.upload import persist_upload_to_temp


@pytest.mark.asyncio
async def test_persist_upload_to_temp_preserves_binary_mxl_bytes(tmp_path):
    """MXL uploads must be written losslessly for music21 ZIP autodetection."""
    data = io.BytesIO()
    with zipfile.ZipFile(data, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("META-INF/container.xml", "<container/>")
        zf.writestr("score.xml", "<score-partwise version='3.1'/>")

    payload = data.getvalue()
    upload = UploadFile(filename="sample.mxl", file=io.BytesIO(payload))

    saved_path = await persist_upload_to_temp(upload, ".mxl")
    try:
        assert saved_path.suffix == ".mxl"
        saved = saved_path.read_bytes()
        assert saved == payload
        with zipfile.ZipFile(io.BytesIO(saved)) as zf:
            assert "score.xml" in zf.namelist()
    finally:
        saved_path.unlink(missing_ok=True)
