from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SessionFrameIn(BaseModel):
    """Validated session frame payload used by session-save requests."""

    model_config = ConfigDict(extra="forbid")

    t: float = Field(ge=0)
    beat: float = Field(ge=0)
    midi: float | None = Field(default=None, ge=0, le=127)
    conf: float = Field(ge=0.0, le=1.0)
    expected_midi: float | None = Field(default=None, ge=0, le=127)
    measure: int | None = Field(default=None, ge=0)


class SessionSaveRequest(BaseModel):
    """Validated request body for POST /session/save."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    part: str = Field(min_length=1)
    created_at: datetime | None = None
    frames: list[SessionFrameIn] = Field(min_length=1, max_length=50000)
