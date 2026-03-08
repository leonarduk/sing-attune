"""
sing-attune Backend — FastAPI application entry point.
Day 2: /score endpoint accepts MusicXML upload and returns parsed ScoreModel.
"""

import tempfile
from pathlib import Path

from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from .score.parser import parse_musicxml

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
    """Return available input devices. Stub — implemented Day 4."""
    return JSONResponse({"devices": [], "note": "audio pipeline not yet initialised"})


@app.post("/score")
async def load_score(file: UploadFile = File(...)) -> JSONResponse:
    """
    Accept a MusicXML upload (.xml or .mxl) and return the parsed ScoreModel.

    The file is written to a temp location, parsed, then deleted.
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
