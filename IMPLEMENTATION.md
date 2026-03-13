# sing-attune — Cross-Platform Singing Pitch Tracker
## Implementation Plan

---

## Overview

A desktop application that loads a MusicXML score, plays the notes through headphones, and overlays real-time pitch detection of the user's voice onto the score as they sing — replicating and extending SingScope's core workflow on Windows.

**The real-time loop:**
1. Score plays piano tones in headphones (Web Audio API + soundfont)
2. User sings along — mic input captured simultaneously
3. CREPE detects pitch from mic at ~20Hz
4. Pitch frames streamed via WebSocket to frontend
5. Frontend plots a moving dot over the score, colour-coded by accuracy
6. Score scrolls to keep the current position visible

**Target stack:** Python backend + browser frontend + Electron shell  
**Packaging:** Electron (Windows desktop), browser-only mode for development  
**Timeline estimate:** ~3 weeks of focused evening work

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Electron Shell                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   Browser Frontend                      │  │
│  │                                                         │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────┐  │  │
│  │  │     Score View (OSMD)   │  │  Pitch Dot Overlay  │  │  │
│  │  │  + scrolling cursor     │  │  (Canvas, ~20Hz)    │  │  │
│  │  └─────────────────────────┘  └─────────────────────┘  │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────┐   │  │
│  │  │         Web Audio API (playback engine)          │   │  │
│  │  │   Piano soundfont → scheduled note events        │   │  │
│  │  │   Plays through headphones → no mic bleed        │   │  │
│  │  └─────────────────────────────────────────────────┘   │  │
│  │                    ▲ WebSocket pitch frames             │  │
│  └────────────────────┼────────────────────────────────────┘  │
└───────────────────────┼────────────────────────────────────────┘
                        │
          ┌─────────────▼───────────────┐
          │       FastAPI Backend        │
          │                             │
          │  POST /score                │  ← MusicXML upload + parse
          │  GET  /audio/devices        │  ← mic enumeration
          │  POST /playback/{cmd}       │  ← start / pause / stop / seek
          │  WS   /ws/pitch             │  ← pitch frame stream
          │                             │
          │  ┌──────────┐ ┌──────────┐  │
          │  │  score/  │ │  audio/  │  │
          │  │ parser   │ │ capture  │  │
          │  │ timeline │ │ pitch    │  │
          │  │ model    │ │ pipeline │  │
          │  └──────────┘ └──────────┘  │
          └─────────────────────────────┘
```

**Key design point — playback lives in the frontend, not the backend.**  
Web Audio API handles note scheduling in the browser. The backend sends the score model (notes + timings); the frontend schedules audio events itself. This avoids streaming audio over the WebSocket and keeps latency low.

---

## Project Structure

```
sing-attune/
├── backend/
│   ├── main.py                  # FastAPI app — REST + WebSocket
│   ├── audio/
│   │   ├── capture.py           # Microphone input (sounddevice)
│   │   ├── pitch.py             # CREPE/aubio pitch detection
│   │   └── pipeline.py          # Audio processing thread + ring buffer
│   ├── score/
│   │   ├── parser.py            # MusicXML → ScoreModel (music21)  ✅
│   │   ├── timeline.py          # Beat ↔ wall-clock time mapping    ✅
│   │   └── model.py             # Pydantic models                   ✅
│   └── tests/
│       └── test_score.py        # 22 tests — parser + timeline      ✅
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── score/
│   │   │   ├── renderer.ts      # OSMD wrapper — score display
│   │   │   └── cursor.ts        # Playback cursor + scroll management
│   │   ├── playback/
│   │   │   ├── engine.ts        # Web Audio API note scheduler
│   │   │   └── soundfont.ts     # Piano soundfont loader (sf2)
│   │   ├── pitch/
│   │   │   ├── overlay.ts       # Canvas pitch dot overlay
│   │   │   └── websocket.ts     # WS client — receives pitch frames
│   │   ├── transport/
│   │   │   └── controls.ts      # Play/pause/stop/tempo/transpose UI
│   │   └── app.ts               # Root — wires everything together
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── electron/
│   ├── main.js                  # Electron main process
│   └── preload.js               # IPC bridge
├── musescore/                   # Test scores
│   ├── homeward_bound.mxl       # Full score (Audiveris → MuseScore)
│   ├── homeward_bound-PARTI.mxl
│   └── homeward_bound-PART_II.mxl
├── pyproject.toml
├── justfile
└── README.md
```

---

## Day-by-Day Build Plan

### Week 1 — Backend Core

#### Day 1: Project scaffold ✅
- uv project, FastAPI skeleton, Vite+TS frontend shell
- Health endpoint, CORS, WebSocket stub
- justfile targets: `just install`, `just dev-backend`, `just dev-frontend`, `just test`

#### Day 2: MusicXML parsing ✅
- `music21` ingestion of `.xml` / `.mxl` files
- `ScoreModel` with `Note`, `TempoMark`, `TimeSignature` (Pydantic v2)
- Tempo fallback via raw XML `<sound tempo="N">` for Audiveris-scanned scores
- `POST /score` endpoint accepts file upload, returns `ScoreModel` JSON
- 22 passing tests including Homeward Bound-specific assertions

#### Day 3: Beat → time timeline ✅
- `Timeline` class: beat ↔ seconds, multi-tempo segment support
- `beat_to_seconds()` and `seconds_to_beat()` with negative clamping
- Tested against Homeward Bound (72 bpm, 189.5 beats → ~157.9 seconds)

#### Day 4: Audio capture
- `sounddevice` mic input, cross-platform device enumeration
- Ring buffer: 2048-sample windows, 50% overlap, 22050 Hz sample rate
- `GET /audio/devices` returns available input devices with names and IDs
- Configurable device selection

#### Day 5: Pitch detection
- CREPE (TensorFlow + CUDA) primary path — GPU on RTX 5070, ~50ms latency
- aubio (YIN) fallback for CPU-only machines
- Output per frame: `{time_ms: float, midi: float, confidence: float}`
- MIDI as float (e.g. 60.3) preserves cent-level detail
- Confidence threshold: discard frames < 0.6
- Auto-detect CUDA at startup, choose engine accordingly

#### Day 6: WebSocket pitch stream
- `WS /ws/pitch` — streams pitch frames at ~20Hz
- Frame format: `{"t": 1234.5, "midi": 60.3, "conf": 0.82}`
- `t` is wall-clock ms from playback start, for sync with score cursor
- `POST /playback/start`, `/pause`, `/stop`, `/seek?beat=N` — playback state management
- Backend and frontend both anchor to the same `t=0` at play press

#### Day 7: Backend integration + tests
- End-to-end: load score → start → stream pitch → verify timestamps align
- Latency measurement: confirm pitch frame → WebSocket delivery < 80ms
- Stress test: 3-minute piece, no drift

---

### Week 2 — Frontend

#### Day 8: Score rendering + audio playback (split day)

**Score rendering (OSMD):**
- Load `ScoreModel` JSON from `POST /score`
- Render score via OpenSheetMusicDisplay
- Playback cursor: highlighted vertical line advancing through the score
- Auto-scroll to keep cursor visible (horizontal continuous scroll mode)

**Audio playback (Web Audio API):**
- Load a General MIDI piano soundfont (sf2 → pre-decoded samples, ~5MB)
- On play: schedule `AudioBufferSourceNode` events for each note in the selected part
- Timing: use `AudioContext.currentTime` as the master clock — this is the `t=0` anchor shared with the backend
- Tempo scaling: reschedule events when tempo slider changes
- Headphone note: display a reminder in the UI — mic bleed from speakers will confuse pitch detection

#### Day 9: Real-time pitch overlay
- Transparent `<canvas>` layer over the OSMD score
- As pitch frames arrive via WebSocket:
  - Map frame `t` → beat position via `seconds_to_beat()`
  - Map beat position → X coordinate on score canvas
  - Map `midi` float → Y coordinate (aligned to staff pitch positions)
  - Draw dot: green (within ±50 cents of expected note), amber (±100 cents), red (outside)
- Dot trail: keep last ~2 seconds of dots visible, fading out
- Canvas scrolls in sync with score cursor

#### Day 10: Note accuracy colouring
- At each frame, find the expected note at the current beat (binary search on `ScoreModel.notes`)
- Compute deviation in cents: `(sung_midi - expected_midi) * 100`
- Colour thresholds:
  - Green: |deviation| ≤ 50 cents
  - Amber: 50 < |deviation| ≤ 100 cents
  - Red: |deviation| > 100 cents
  - Grey: confidence < 0.6 (unvoiced / uncertain)

#### Day 11: Transport controls
- Play / Pause / Stop / Rewind buttons — call `POST /playback/{cmd}` + Web Audio API
- Tempo slider: ±50% range — reschedules Web Audio events, updates timeline
- Transposition selector: semitones up/down — backend re-maps MIDI values in `ScoreModel`
- File picker: drag-and-drop or browse for `.mxl` / `.xml`
- Keyboard shortcuts: Space (play/pause), R (rewind), ← → (seek by measure)

#### Day 12: Settings panel
- Mic device selector (from `GET /audio/devices`)
- Pitch engine toggle: CREPE / aubio
- Octave compensation: +1 / 0 / -1 octave (for male voices on treble-clef parts)
- Confidence threshold slider (default 0.6)
- Dot trail length slider

#### Day 13: Part selector
- Dropdown populated from `ScoreModel.parts`
- Filters which notes are used for expected-pitch comparison
- Filters which notes are scheduled for audio playback
- Piano parts hidden by default, accessible if wanted

#### Day 14: Polish + UX
- Loading states: spinner on score upload, skeleton on first render
- Error states: no mic permission, unsupported MusicXML, backend unreachable
- Part II silence handling: no dot shown during rests / before entry
- Responsive layout: works at 1080p and above

---

### Week 3 — Packaging + Edge Cases

#### Day 15: Repeats handling
- Expand repeat barlines, D.S., D.C. al Fine in the score model
- `music21` `expandRepeats()` on the stream before note extraction
- Update timeline to reflect expanded beat sequence
- Critical for choir music — almost all pieces have repeats

#### Day 16: Electron packaging
- Electron main process launches FastAPI backend as child process
- `pyinstaller` produces self-contained backend binary (no Python install required)
- `electron-builder` produces Windows `.exe` installer
- Backend port chosen dynamically to avoid conflicts
- Auto-restart backend if it crashes

#### Day 17: CUDA / CPU detection + fallback
- At startup: probe CUDA via `torch.cuda.is_available()` or `tensorflow` device list
- Surface result in settings: "Pitch engine: CREPE (RTX 5070)" or "Pitch engine: aubio (CPU)"
- Warn if CPU-only: CREPE latency ~200ms, recommend aubio
- Allow manual override in settings

#### Day 18: Session recording + review
- Record session: pitch frames saved as `[{t, beat, midi, conf, expected_midi}]` JSON
- Review mode: replay saved trace over score (no mic needed)
- Export as CSV: `beat, expected_midi, sung_midi, cents_deviation`
- Basic stats: % notes within 50 cents, % within 100 cents

#### Day 19: Real-score testing
- Full run-through with Homeward Bound Part I and Part II
- Verify Part II long silence (beat 0–29) handled gracefully — no phantom dots
- Anacrusis (Part I enters at beat 5): cursor and audio must align from bar 0
- Fermatas: audio pauses, pitch detection continues
- Tied notes: single expected pitch across the tie

#### Day 20: Buffer + documentation
- Update README with final install instructions
- Known limitations: polyphony not supported, melisma detection approximate, falsetto may confuse CREPE
- Record a short demo GIF
- Buffer for anything that slipped

---

## Key Dependencies

### Backend
```
fastapi>=0.111
uvicorn[standard]
websockets
music21>=9.1
sounddevice
numpy
crepe              # GPU pitch detection (needs tensorflow)
aubio              # CPU pitch detection fallback
pydantic>=2.0
python-multipart
```

### Frontend
```
opensheetmusicdisplay   # MusicXML score rendering
typescript
vite
```
Soundfont loaded at runtime from a CDN or bundled — no npm package needed.

### Electron
```
electron
electron-builder
```

---

## Key Technical Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Mic bleed from speakers corrupts pitch detection | High | **Use headphones** — enforced in UI with a warning. Speakers not supported. |
| Web Audio API scheduling drift over long pieces | Medium | Use `AudioContext.currentTime` as master clock throughout; never use `Date.now()` for sync |
| CREPE latency too high on CPU | High | aubio fallback; auto-detect CUDA at startup |
| OSMD struggles with Audiveris-scanned scores | Medium | Test on Day 8; use MuseScore-exported files as primary test case |
| Beat/time sync drift | Medium | Anchor at measure boundaries; recalibrate on seek |
| Repeat/DS/DC handling in music21 | Medium | `expandRepeats()` before note extraction |
| MusicXML dialect variation (Sibelius vs MuseScore vs Audiveris) | Medium | MuseScore exports as primary; log parse warnings for others |
| Electron + pyinstaller bundle size | Low | ~200MB with TF deps — acceptable for desktop |
| Part II silence (long rest before entry) | Low | Filter notes with `beat_start > current_beat`; skip dot rendering during silence |

---

## Deferred / Out of Scope (v1)

- **Android** — defer until Windows desktop is solid
- **Polyphony** — single voice only (same limitation as SingScope)
- **MIDI input** — not needed for voice practice
- **Cloud sync** — local only
- **Vibrato analysis** — interesting, not core
- **Accompaniment playback** — piano part alongside vocal part; deferred to v2

---

## Definition of Done (v1)

- [ ] Load any MuseScore-exported MusicXML file
- [ ] Select a part from a multi-part score
- [ ] Hear the selected part played as piano tone through headphones
- [ ] Sing along and see your pitch as a real-time moving dot on the score
- [ ] Dot is colour-coded green/amber/red by accuracy
- [ ] Score scrolls to keep the current position visible
- [ ] Tempo and transposition controls work
- [ ] Installs as a Windows desktop app without requiring Python pre-installed
- [ ] Tested against Homeward Bound Parts I and II

## Milestone 2 closure note (issue #48)

Interpretation boundary for v0.2 is now explicit: backend remains raw pitch-frame transport (`{t,midi,conf}`), while expected-note lookup and colour classification are frontend responsibilities.
