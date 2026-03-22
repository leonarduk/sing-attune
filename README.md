# sing-attune

[![codecov](https://codecov.io/gh/leonarduk/sing-attune/branch/main/graph/badge.svg)](https://codecov.io/gh/leonarduk/sing-attune)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Practice your choir part. Hear the notes. Sing along. See your pitch in real time.**

sing-attune plays your part from a MusicXML score through your headphones. You sing along. As you sing, your pitch appears live on the score — a moving dot over the notation, green when you're on it, red when you're not. No post-hoc analysis, no percentage scores. Just an honest mirror of what your voice is doing, in the moment, against what the music asks for.

## Demo

Demo GIF is shared in the PR/release notes (kept out of the repository to avoid committing binary assets).

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

## Soundfont licensing and offline playback

- The app now bundles `FluidR3_GM/acoustic_grand_piano-mp3.js` at `frontend/public/soundfonts/FluidR3_GM/` and loads it locally first.
- This removes runtime CDN dependency for packaged/offline usage.
- Licence audit and attribution details are documented in [`docs/soundfont-licensing.md`](docs/soundfont-licensing.md) and [`NOTICE`](NOTICE).

---

## Pitch interpretation boundary

In v0.2, backend and frontend responsibilities are explicit:

- Backend emits **raw** pitch frames only: `{t,midi,conf}` via `/ws/pitch`
- Frontend computes expected-note matching and overlay colour decisions

This keeps the backend real-time pipeline simple while score-aware interpretation stays in the UI layer where the rendered score context already exists.

---

## Status

🚧 **Early development** — backend complete through Day 7, frontend score rendering (Day 8a) now working, Electron bootstrap in progress (Day 16a).

| Component | Status |
|-----------|--------|
| MusicXML parser | ✅ Done |
| Beat → time timeline | ✅ Done |
| FastAPI backend | ✅ Done |
| Audio capture (mic) | ✅ Done |
| Pitch detection (torchcrepe/pYIN) | ✅ Done |
| WebSocket pitch stream | ✅ Done |
| Backend integration tests | ✅ Done |
| Note segmentation | ✅ Done (Day 259) |
| Score renderer (OSMD) | ✅ Done (Day 8a) |
| Score playback (Web Audio) | 🔲 Day 9 |
| Real-time pitch overlay | ✅ Done (Day 10) |
| Transport controls | 🔲 Day 11 |
| Electron packaging | ✅ Done (Day 16c) |
| Backend standalone binary (PyInstaller) | ✅ Done (Day 16b) |

---

## Known limitations (v1.0)

- **Polyphony is not supported** — pitch tracking assumes one singing voice at a time.
- **Melisma alignment is approximate** — long syllables spanning many notes can produce ambiguous note matching.
- **Falsetto / airy phonation can confuse CREPE** — confidence may drop and cause gaps in the visible pitch trace.

---

## Requirements

- Windows 10/11 (macOS/Linux should work in browser-only mode)
- Python 3.12+
- Node 18+
- [uv](https://github.com/astral-sh/uv) — `winget install astral-sh.uv`
- [just](https://github.com/casey/just)
- Windows Developer Mode enabled (required for Windows packaging symlink creation checks)
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

### First rehearsal in the app

1. Open the app and click **Browse…** or drag a score into the drop zone. Supported score files are **MusicXML `.xml`** and **compressed MusicXML `.mxl`**.
2. Choose your **Part**, optionally enable **Show all parts**, and adjust **Transpose** or **Tempo** if the piece needs to sit differently for your voice.
3. Open **Settings** to confirm the microphone device, confidence threshold, pitch trail length, and stable-note detection parameters.
4. Use **Warm-up** if you want a guided setup period, then press **Play** and sing along with headphones on.
5. Watch the **Pitch graph** during rehearsal, then review **Phrase summary**, **Practice history**, and **Audio transcription** when you finish.

### Panel guide

- **Pitch graph**: rolling 10-second graph of your detected pitch against the expected notes.
- **Part mixer**: balance your selected part against the accompaniment when a score includes multiple parts.
- **Warm-up**: quick timer and transition into rehearsal mode.
- **Phrase summary**: short feedback after each completed phrase showing note-level accuracy.
- **Practice history**: stores recent session summaries locally for comparison over time.
- **Audio transcription**: upload MP3/WAV audio and export a generated MusicXML transcription.

### Developer setup

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

### Backend environment variables

- `CORS_ORIGINS` — comma-separated list of allowed browser origins for the FastAPI backend. Defaults to `http://localhost:5173,http://127.0.0.1:5173`. Override this when running Vite on a different port or when you need multiple frontend origins during development.
- `ELECTRON_MODE` — set to `1` when the backend is launched by the packaged Electron app. In this mode the backend uses wildcard CORS with credentials disabled so `app://` and `file://` renderers can reach the API without rebuilding the backend.

Example:

```powershell
$env:CORS_ORIGINS="http://localhost:5174,http://127.0.0.1:4173"
just dev-backend
```

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
| Desktop packaging | Electron + PyInstaller backend binary |

---

## Windows installer packaging (Electron)

Build the Windows installer with:

```powershell
just package
```

### Windows packaging prerequisites

- Enable **Developer Mode** in Windows: **Settings → System → For developers → Developer Mode → On**.
- Build the backend bundle first:

```powershell
just build-backend
```

`just package` runs a preflight script that:

- Removes `frontend/node_modules/gl` if present (avoids Windows native rebuild failures)
- Verifies `dist/sing-attune-backend` exists
- Materializes `electron/assets/icon.ico` from committed `electron/assets/icon.ico.base64` placeholder data when needed
- Verifies `electron/assets/icon.ico` is present and non-empty
- On Windows, verifies symlink privileges required by the packaging pipeline

If any prerequisite is missing, packaging stops with a clear error message.

---
## Installer variants

Two packaged variants are now produced for different hardware profiles:

| Variant | Filename pattern | Includes | Best for |
|---|---|---|---|
| Thin (CPU) | `sing-attune-<version>-x64.exe` | librosa pYIN backend only | Most users, smallest download |
| Full-fat (GPU) | `sing-attune-<version>-gpu-x64.exe` | torchcrepe + PyTorch + CPU fallback | NVIDIA GPU users needing lower latency |

If you're unsure which one to download, start with the **thin** build.

## Backend packaging (Day 16b)

Build a standalone backend binary with PyInstaller:

```powershell
just build-backend

# Thin CPU-only backend bundle
just build-backend-thin
```

Output is written to `dist/sing-attune-backend/` (full-fat) and `dist/sing-attune-backend-thin/` (thin).
The bundles can be launched with:

```powershell
./dist/sing-attune-backend/sing-attune-backend
```

### Bundle size

- Thin build target: **<250 MB** (`dist/sing-attune-backend-thin`)
- Full-fat GPU build: typically significantly larger because torch/torchcrepe + CUDA libraries are bundled

---

## Desktop packaging (Windows installer)

The repository now includes `electron-builder` wiring for a Windows NSIS installer (`.exe`).

### Prerequisites

- Windows Developer Mode enabled (`Settings -> System -> For developers -> Developer Mode -> On`) so electron-builder can extract signing tool symlinks.
- Frontend dependencies installed (`cd frontend && npm install`)
- Frontend build succeeds (`npm run build`)
- PyInstaller backend bundle present at `dist/sing-attune-backend/` (build via `just build-backend` before packaging)

### Build installer

From the repository root:

```powershell
just package
```

Or directly:

```powershell
cd frontend
npm run package:win
```

Installer artifacts are written to `frontend/release/` (for example `sing-attune-x.y.z-x64-setup.exe`).

**Current installer-size expectation:** ~200 MB once bundled with backend runtime dependencies (Tensor/PyTorch stack dominates size).

## Known limitations

- Real-time pitch tracking is monophonic: **polyphonic singing is not supported**.
- Melisma detection remains approximate in challenging passages with rapid ornaments.
- Falsetto/airy tone can reduce CREPE confidence and produce unstable pitch traces.

## CI / development

Every pull request runs:
- **ruff** — Python linter
- **pytest** — backend test suite with coverage (hardware tests auto-skip in CI)
- **frontend-test** — frontend unit tests (Vitest)
- **e2e** — frontend end-to-end tests (Playwright + Chromium)
- **Codecov** — coverage delta reported on every PR
- **Claude AI review** — reviews the diff against the linked issue's acceptance criteria

Every published GitHub release runs:
- **package-on-release** — Windows packaging pipeline that lints/tests, builds the backend with PyInstaller, packages the Electron app, uploads artifacts to the workflow run, and attaches the ZIP + `SHA256SUMS.txt` to the Release page.

Run locally before pushing:

Backend (lint + tests):
```powershell
uv run ruff check backend/ --fix
uv run pytest -v --cov=backend --cov-report=term-missing
```

Frontend unit tests (Vitest):
```powershell
cd frontend
npm install
npm test
```

Frontend E2E tests (Playwright):
```powershell
cd frontend
npm install
npx playwright install chromium   # one-time, downloads ~120MB
npm run test:e2e
```

> [!NOTE]
> `npx playwright install chromium` downloads browser binaries from `https://playwright.azureedge.net`.
> On restricted networks this can fail; when that happens, rely on the CI `e2e` job instead of local E2E runs.

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
electron/
  main.js         Electron shell: backend process lifecycle + dynamic port + splash
  preload.js      Secure IPC bridge for backend runtime config
.github/
  workflows/      PR review: ruff + pytest + frontend-test + e2e + Codecov + Claude AI review
  scripts/        claude_review.py — AI review script
musescore/        Test scores (Homeward Bound, Parts I & II)
```

Full build plan: [IMPLEMENTATION.md](IMPLEMENTATION.md)

---

## Licence

Licensed under the [Apache License 2.0](LICENSE) — permissive open-source licensing with an explicit patent grant.