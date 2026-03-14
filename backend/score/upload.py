"""Helpers for persisting uploaded score files safely."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import UploadFile


async def persist_upload_to_temp(file: UploadFile, suffix: str) -> Path:
    """Write an UploadFile to a temp path, preserving exact binary bytes."""
    await file.seek(0)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        shutil.copyfileobj(file.file, tmp)
        tmp.flush()

    return tmp_path

