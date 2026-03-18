"""
sing-attune Backend — FastAPI application entry point.
Day 6: Playback state machine + real WebSocket pitch stream.
"""

import asyncio
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
import uvicorn

from .score.parser import parse_musicxml
from .score.upload import persist_upload_to_temp
from .audio.capture import list_input_devices, default_input_device_id
from .audio.pipeline import PlaybackPipeline, _CLIENT_QUEUE_MAXSIZE
from .session.store import list_sessions, read_session, save_session
from .transcription_service import TranscriptionError, transcribe_audio_file

app = FastAPI(
    title="sing-attune",
    description="MusicXML pitch tracking backend",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Application-lifetime pipeline (one instance per process) ──────────────────

_pipeline = PlaybackPipeline()

# Keepalive interval in seconds. If no pitch frames arrive for this long
# (e.g. during PAUSED state), a ping is sent to keep the connection alive.
_WS_KEEPALIVE_S = 5.0


# ── Health ─────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> JSONResponse:
    runtime = _pipeline.runtime_info
    return JSONResponse({
        "status": "ok",
        "version": "0.2.0",
        "engine": runtime.engine.name.lower(),
        "cuda": runtime.cuda,
        "device": runtime.device,
    })


# ── Audio devices ──────────────────────────────────────────────────────────────


@app.get("/audio/devices")
async def list_audio_devices() -> JSONResponse:
    devices = list_input_devices()
    default_id = default_input_device_id()
    return JSONResponse(
        {
            "default_device_id": default_id,
            "devices": [
                {
                    "id": d.id,
                    "name": d.name,
                    "channels": d.channels,
                    "host_api": d.host_api,
                    "default_sample_rate": d.default_sample_rate,
                }
                for d in devices
            ],
        }
    )


@app.get("/audio/engine")
async def audio_engine() -> JSONResponse:
    """Read-only: return current engine state."""
    runtime = _pipeline.runtime_info
    return JSONResponse(
        {
            "active_engine": runtime.engine.name.lower(),
            "mode": runtime.mode,
            "switchable": True,
            "cuda": runtime.cuda,
            "device": runtime.device,
            "force_cpu": _pipeline.force_cpu,
        }
    )


@app.post("/audio/engine/force-cpu")
async def set_engine_force_cpu(force_cpu: bool) -> JSONResponse:
    """Mutate engine mode: enable or disable forced-CPU override."""
    _pipeline.set_force_cpu(force_cpu)
    runtime = _pipeline.runtime_info
    return JSONResponse(
        {
            "active_engine": runtime.engine.name.lower(),
            "mode": runtime.mode,
            "switchable": True,
            "cuda": runtime.cuda,
            "device": runtime.device,
            "force_cpu": _pipeline.force_cpu,
        }
    )


# ── Playback state machine ─────────────────────────────────────────────────────


@app.post("/playback/start")
async def playback_start(device_id: int | None = None) -> JSONResponse:
    """
    Begin audio capture and pitch detection.
    Records t=0 — must be called at the same moment the frontend starts
    AudioContext playback so both clocks anchor together.

    Query param: device_id (optional) — sounddevice input device index.
    Omit to use the system default.
    """
    loop = asyncio.get_event_loop()
    _pipeline.start(device_id=device_id, loop=loop)
    return JSONResponse({"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms})


@app.post("/playback/pause")
async def playback_pause() -> JSONResponse:
    """Suspend capture and hold the current t offset."""
    _pipeline.pause()
    return JSONResponse({"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms})


@app.post("/playback/resume")
async def playback_resume() -> JSONResponse:
    """Resume capture from the held t offset."""
    _pipeline.resume()
    return JSONResponse({"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms})


@app.post("/playback/stop")
async def playback_stop() -> JSONResponse:
    """Stop capture, destroy pipeline, reset t to zero."""
    _pipeline.stop()
    return JSONResponse({"state": _pipeline.state.name, "t_ms": 0.0})


@app.get("/playback/state")
async def playback_state() -> JSONResponse:
    """Return current playback state and position — useful for frontend reconnect."""
    return JSONResponse({"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms})


@app.post("/playback/seek")
async def playback_seek(t_ms: float) -> JSONResponse:
    """Seek playback position in milliseconds while retaining current state."""
    if t_ms < 0:
        raise HTTPException(status_code=400, detail="t_ms must be >= 0")
    _pipeline.seek(t_ms)
    return JSONResponse({"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms})


@app.post("/playback/tempo")
async def playback_tempo(multiplier: float) -> JSONResponse:
    """Set playback tempo multiplier used for elapsed-time calculations."""
    if multiplier <= 0:
        raise HTTPException(status_code=400, detail="multiplier must be > 0")
    _pipeline.set_tempo_multiplier(multiplier)
    return JSONResponse(
        {"state": _pipeline.state.name, "t_ms": _pipeline.elapsed_ms, "multiplier": _pipeline.tempo_multiplier}
    )


@app.post("/playback/transpose")
async def playback_transpose(semitones: int) -> JSONResponse:
    """
    Set the active transposition offset in semitones.

    The frontend applies the same offset to Web Audio detune so the audio
    played back is shifted. This endpoint stores the offset so the pitch
    interpretation layer (Day 9) can shift expected MIDI targets when
    comparing detected f0 against score notes.

    Range clamped to [-12, +12] on the pipeline side.
    """
    _pipeline.set_transpose_semitones(semitones)
    return JSONResponse(
        {
            "state": _pipeline.state.name,
            "t_ms": _pipeline.elapsed_ms,
            "transpose_semitones": _pipeline.transpose_semitones,
        }
    )


# ── WebSocket pitch stream ─────────────────────────────────────────────────────


@app.websocket("/ws/pitch")
async def pitch_stream(websocket: WebSocket) -> None:
    """
    Stream real-time pitch frames to the frontend at ~20Hz.

    Frame format: {"t": float, "midi": float, "conf": float}
      t    — ms since playback start (aligned with AudioContext.currentTime * 1000)
      midi — MIDI float with cent detail (e.g. 60.3 = C4 + 30 cents)
      conf — confidence 0.0–1.0 (frames below 0.6 are dropped before reaching here)

    The client receives frames only during PLAYING state.
    Connection survives pause/resume — no reconnect needed.
    A keepalive ping is sent every _WS_KEEPALIVE_S seconds when no frames arrive
    (e.g. during PAUSED state) so the connection stays open.
    """
    await websocket.accept()
    await websocket.send_json({"status": "connected"})

    q: asyncio.Queue = asyncio.Queue(maxsize=_CLIENT_QUEUE_MAXSIZE)
    _pipeline.add_client(q)

    try:
        while True:
            try:
                frame = await asyncio.wait_for(q.get(), timeout=_WS_KEEPALIVE_S)
                await websocket.send_json(frame)
            except asyncio.TimeoutError:
                # No frames for _WS_KEEPALIVE_S seconds (e.g. paused) — send ping
                await websocket.send_json({"ping": True})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _pipeline.remove_client(q)


# ── Session recording persistence ─────────────────────────────────────────────


@app.post("/session/save")
async def session_save(payload: dict[str, Any]) -> JSONResponse:
    frames = payload.get("frames")
    if not isinstance(frames, list):
        raise HTTPException(status_code=400, detail="frames must be a list")

    normalized_payload = {
        "title": str(payload.get("title") or "Untitled"),
        "part": str(payload.get("part") or "Unknown"),
        "created_at": str(payload.get("created_at") or ""),
        "frames": [
            {
                "t": float(frame.get("t", 0.0)),
                "beat": float(frame.get("beat", 0.0)),
                "midi": None if frame.get("midi") is None else float(frame.get("midi")),
                "conf": float(frame.get("conf", 0.0)),
                "expected_midi": None if frame.get("expected_midi") is None else float(frame.get("expected_midi")),
                "measure": None if frame.get("measure") is None else int(frame.get("measure")),
            }
            for frame in frames
            if isinstance(frame, dict)
        ],
    }

    session_id, _ = save_session(normalized_payload)
    return JSONResponse({"id": session_id, "frame_count": len(normalized_payload["frames"])})


@app.get("/session/list")
async def session_list() -> JSONResponse:
    return JSONResponse({"sessions": list_sessions()})


@app.get("/session/{session_id}")
async def session_get(session_id: str) -> JSONResponse:
    try:
        payload = read_session(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(payload)


# ── Score upload ───────────────────────────────────────────────────────────────


@app.post("/transcribe/audio")
async def transcribe_audio(file: UploadFile = File(...)) -> Response:
    suffix = Path(file.filename or "audio.wav").suffix.lower()
    if suffix not in {".wav", ".wave"}:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Upload a .wav audio file.",
        )

    tmp_path = await persist_upload_to_temp(file, suffix)

    try:
        transcription = transcribe_audio_file(tmp_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except TranscriptionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    return Response(
        content=transcription.musicxml,
        media_type="application/vnd.recordare.musicxml+xml",
        headers={"Content-Disposition": 'inline; filename="transcription.musicxml"'},
    )


@app.post("/score")
async def load_score(file: UploadFile = File(...)) -> JSONResponse:
    suffix = Path(file.filename or "score.xml").suffix.lower()
    if suffix not in {".xml", ".mxl"}:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Upload a .xml or .mxl MusicXML file.",
        )

    tmp_path = await persist_upload_to_temp(file, suffix)

    try:
        score_model = parse_musicxml(tmp_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    return JSONResponse(score_model.model_dump())


if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
