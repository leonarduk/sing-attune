"""
sing-attune Backend — FastAPI application entry point.
Day 4: /audio/devices endpoint wired to real sounddevice enumeration.
"""

import tempfile
from pathlib import Path

from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from .score.parser import parse_musicxml
from .audio.capture import list_input_devices, default_input_device_id

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


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.2.0"})


@app.get("/audio/devices")
async def list_audio_devices() -> JSONResponse:
    """
    Return available audio input devices and the current default.

    Response schema:
        {
            "default_device_id": int,
            "devices": [
                {"id": int, "name": str, "channels": int,
                 "host_api": str, "default_sample_rate": float},
                ...
            ]
        }
    """
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


@app.post("/score")
async def load_score(file: UploadFile = File(...)) -> JSONResponse:
    """
    Accept a MusicXML upload (.xml or .mxl) and return the parsed ScoreModel.
    """
    suffix = Path(file.filename or "score.xml").suffix.lower()
    if suffix not in {".xml", ".mxl"}:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Upload a .xml or .mxl MusicXML file.",
        )

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    try:
        score_model = parse_musicxml(tmp_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    return JSONResponse(score_model.model_dump())


@app.websocket("/ws/pitch")
async def pitch_stream(websocket: WebSocket) -> None:
    """Stream real-time pitch frames to the frontend. Stub — implemented Day 6."""
    await websocket.accept()
    await websocket.send_json({"status": "connected", "note": "pitch pipeline not yet active"})
    await websocket.close()


if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
