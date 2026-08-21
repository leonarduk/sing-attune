"""Construction and typing for the versioned pitch-frame wire protocol."""

from __future__ import annotations

from typing import Literal, TypedDict

PITCH_FRAME_PROTOCOL_VERSION: Literal[1] = 1


class PitchFramePayload(TypedDict):
    """JSON-compatible v1 frame sent by the backend over ``/ws/pitch``."""

    v: Literal[1]
    t: float
    midi: float
    conf: float


def encode_pitch_frame(*, t_ms: float, midi: float, confidence: float) -> PitchFramePayload:
    """Encode detector values without changing the established wire precision."""
    return {
        "v": PITCH_FRAME_PROTOCOL_VERSION,
        "t": round(t_ms, 1),
        "midi": round(midi, 3),
        "conf": round(confidence, 3),
    }
