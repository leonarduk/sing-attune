# sing-attune

[![codecov](https://codecov.io/gh/leonarduk/sing-attune/branch/main/graph/badge.svg)](https://codecov.io/gh/leonarduk/sing-attune)

**Practice your choir part. Hear the notes. Sing along. See your pitch in real time.**

sing-attune plays your part from a MusicXML score through your headphones. You sing along. As you sing, your pitch appears live on the score — a moving dot over the notation, green when you're on it, red when you're not. No post-hoc analysis, no percentage scores. Just an honest mirror of what your voice is doing, in the moment, against what the music asks for.

---

## The loop

1. Load a MusicXML file (MuseScore, Sibelius, Finale, Audiveris)
2. Select your part
3. Press play — the score plays piano tones through your headphones
4. Sing along
5. Watch your pitch trace appear over the score in real time

That's it.

---

## Pitch graph panel

The UI now includes a dedicated pitch graph canvas under the toolbar:

- Semitone grid from **C2 to C6** with octave labels
- Rolling **10-second** time window with 1-second vertical grid lines
- Continuous f0 trace colour-coded against the active target note:
  - **Green**: within ±25 cents
  - **Red**: outside ±25 cents
  - **Grey**: no active target note

For backend-free testing, enable **Synthetic pitch input (no WebSocket)** in Settings. This feeds deterministic test frames so you can validate rendering and scrolling even when the backend pitch stream is unavailable.

---

## Why it exists

[SingScope](http://www.singscope.com/en/) does this brilliantly — but only on iOS. If you're a choir singer who practices on a Windows PC, or wants a bigger screen than an iPad, there's nothing that combines score display, part playback, and real-time pitch tracking in one tool. sing-attune fills that gap.

---

## Features (planned)

- **MusicXML import** — works with exports from MuseScore, Sibelius, Finale, and Audiveris
- **Part playback** — piano tone synthesis via Web Audio API + soundfont, directly in the browser. Use headphones to prevent mic bleed.
- **Real-time pitch detection** — powered by [torchcrepe](https://github.com/maxrmorrison/torchcrepe) (GPU) or librosa pYIN (CPU fallback), running locally
- **Live pitch overlay** — your sung pitch plotted over the score as a moving dot, colour-coded: green (on pitch), amber (close), red (off)
- **Score scrolls with you** — the view follows the playback cursor so you never lose your place
- **Part selector** — choose your voice part from a multi-part score
- **Tempo and transposition controls** — slow it down, shift the key
- **Settings panel** — mic device picker, confidence threshold, trail length, and active engine display
- **Octave compensation** — for male voices singing parts notated an octave higher
- **Session recording and review** — replay your pitch trace over the score after you finish
- **Runs locally** — no cloud, no subscription, no account

---


## Pitch interpretation boundary

In v0.2, backend and frontend responsibilities are explicit:

- Backend emits **raw** pitch frames only: `{t,midi,conf}` via `/ws/pitch`
- Frontend computes expected-note matching and overlay colour decisions

This keeps the backend real-time pipeline simple while score-aware interpretation stays in the UI layer where the rendered score context already exists.

---

## Status

🚧 **Early development** — backend complete through Day 7, frontend score rendering (Day 8a) now working.

| Component | Status |
|-----------|--------|
| MusicXML parser | ✅ Done |
| Beat → time timeline | ✅ Done |
| FastAPI backend | ✅ Done |
| Audio capture (mic) | ✅ Done |
| Pitch detection (torchcrepe/pYIN) | ✅ Done |
| WebSocket pitch stream | ✅ Done |
| Backend integration tests | ✅ Done |
| Score renderer (OSMD) | ✅ Done (Day 8a) |
| Score playback (Web Audio) | 🔲 Day 9 |
| Real-time pitch overlay | ✅ Done (Day 10) |
| Transport controls | 🔲 Day 11 |
| Electron packaging | 🔲 Day 16 |

---

## Requirements

- Windows 10/11 (macOS/Linux should work in browser-only mode)
- Python 3.12+
- Node 18+
- [uv](https://github.com/astral-sh/uv) — `winget install astral-sh.uv`
- [just](https://github.com/casey/just)
- NVIDIA GPU with CUDA 12.x recommended (for torchcrepe pitch detection; librosa pYIN works on CPU)
- **Headphones** — essential during practice to prevent mic picking up the playback

### Install `just`

Use the package manager that matches your system:

- **Windows (winget)**: `winget install Casey.Just`
- **Windows (Scoop)**: `scoop install just`
- **Windows (Chocolatey)**: `choco install just`
- **macOS (Homebrew)**: `brew install just`
- **Ubuntu/Debian**: `sudo apt install just`
- **Cross-platform via Cargo**: `cargo install just`

Verify install:

```powershell
just --version
```

---

## Quick start

```powershell
git clone https://github.com/leonarduk/sing-attune
cd sing-attune

# Install Python dependencies
uv sync

# Install PyTorch with CUDA support (adjust cu128 to match your CUDA version)
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install torchcrepe

# Install Node dependencies
cd frontend && npm install && cd ..

# Terminal 1 — start backend
just dev-backend

# Terminal 2 — start frontend
just dev-frontend
```

Open http://localhost:5173

API docs: http://localhost:8000/docs

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, uvicorn |
| Score parsing | music21 |
| Pitch detection (GPU) | torchcrepe (PyTorch-based CREPE) |
| Pitch detection (CPU) | librosa pYIN |
| Score rendering | OpenSheetMusicDisplay (OSMD) |
| Score playback | Web Audio API + piano soundfont |
| Frontend | Vite, TypeScript |
| Desktop packaging | Electron (planned) |

---

## CI / development

Every pull request runs:
- **ruff** — Python linter
- **pytest** — full test suite with coverage (hardware tests auto-skip in CI)
- **Codecov** — coverage delta reported on every PR
- **Claude AI review** — reviews the diff against the linked issue's acceptance criteria

Run locally before pushing:
```powershell
uv run ruff check backend/ --fix
uv run pytest -v --cov=backend --cov-report=term-missing
```

See [CLAUDE.md](CLAUDE.md) for branching conventions and the full pre-commit checklist.

---

## Project structure

```
backend/
  score/          MusicXML parsing, data models, beat-time timeline
  audio/          Mic capture, pitch detection pipeline, playback state machine
  tests/          pytest suite (hardware tests auto-skip in CI)
  main.py         FastAPI app, REST endpoints, WebSocket pitch stream
frontend/
  src/            Vite + TypeScript — score renderer, pitch canvas, playback, controls
.github/
  workflows/      PR review: ruff + pytest + Codecov + Claude AI review
  scripts/        claude_review.py — AI review script
musescore/        Test scores (Homeward Bound, Parts I & II)
```

Full build plan: [IMPLEMENTATION.md](IMPLEMENTATION.md)

---

## Licence

Apache-2.0 — permissive open-source licensing with an explicit patent grant.
