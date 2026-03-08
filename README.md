# sing-attune

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

## Why it exists

[SingScope](http://www.singscope.com/en/) does this brilliantly — but only on iOS. If you're a choir singer who practices on a Windows PC, or wants a bigger screen than an iPad, there's nothing that combines score display, part playback, and real-time pitch tracking in one tool. sing-attune fills that gap.

---

## Features (planned)

- **MusicXML import** — works with exports from MuseScore, Sibelius, Finale, and Audiveris
- **Part playback** — piano tone synthesis via Web Audio API + soundfont, directly in the browser. Use headphones to prevent mic bleed.
- **Real-time pitch detection** — powered by [CREPE](https://github.com/marl/crepe) (GPU) or aubio (CPU fallback), running locally
- **Live pitch overlay** — your sung pitch plotted over the score as a moving dot, colour-coded: green (on pitch), amber (close), red (off)
- **Score scrolls with you** — the view follows the playback cursor so you never lose your place
- **Part selector** — choose your voice part from a multi-part score
- **Tempo and transposition controls** — slow it down, shift the key
- **Octave compensation** — for male voices singing parts notated an octave higher
- **Session recording and review** — replay your pitch trace over the score after you finish
- **Runs locally** — no cloud, no subscription, no account

---

## Status

🚧 **Early development** — backend data layer complete, UI in progress.

| Component | Status |
|-----------|--------|
| MusicXML parser | ✅ Done |
| Beat → time timeline | ✅ Done |
| FastAPI backend | ✅ Scaffold done |
| Audio capture (mic) | 🔲 Day 4 |
| Pitch detection (CREPE) | 🔲 Day 5 |
| WebSocket pitch stream | 🔲 Day 6 |
| Score renderer (OSMD) | 🔲 Day 8 |
| Score playback (Web Audio) | 🔲 Day 8 |
| Real-time pitch overlay | 🔲 Day 9 |
| Transport controls | 🔲 Day 11 |
| Electron packaging | 🔲 Day 16 |

---

## Requirements

- Windows 10/11 (macOS/Linux should work in browser-only mode)
- Python 3.11+
- Node 18+
- [uv](https://github.com/astral-sh/uv) — `winget install astral-sh.uv`
- [just](https://github.com/casey/just) — `winget install Casey.Just`
- NVIDIA GPU with CUDA 12.x recommended (for CREPE pitch detection; aubio works on CPU)
- **Headphones** — essential during practice to prevent mic picking up the playback

---

## Quick start

```powershell
git clone https://github.com/yourusername/sing-attune
cd sing-attune

# Install all dependencies
just install

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
| Backend | Python, FastAPI, uvicorn |
| Score parsing | music21 |
| Pitch detection | CREPE (GPU) / aubio (CPU) |
| Score rendering | OpenSheetMusicDisplay (OSMD) |
| Score playback | Web Audio API + piano soundfont |
| Frontend | Vite, TypeScript |
| Desktop packaging | Electron (planned) |

---

## Project structure

```
backend/
  score/          MusicXML parsing, data models, beat-time timeline
  audio/          Mic capture, pitch detection pipeline
  main.py         FastAPI app, WebSocket pitch stream
frontend/
  src/            Vite + TypeScript — score renderer, pitch canvas, playback, controls
musescore/        Test scores (Homeward Bound, Parts I & II)
```

Full build plan: [IMPLEMENTATION.md](IMPLEMENTATION.md)

---

## Licence

MIT — do what you want with it.
