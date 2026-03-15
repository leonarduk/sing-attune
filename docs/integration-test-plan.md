# sing-attune Integration Test Plan (AI-Executable)

## Scope

This plan defines deterministic integration scenarios that an AI agent can execute against a running sing-attune stack.

In scope:
- Backend process lifecycle and HTTP endpoints
- MusicXML upload + score model validation
- WebSocket pitch streaming lifecycle and frame contract
- Frontend score load, part selector, transport, cursor sync, and tempo controls
- CPU and GPU pitch-engine validation with synthetic audio input

Out of scope:
- Electron shell packaging/runtime
- Soundfont CDN availability/performance benchmarking
- End-user microphone quality and room acoustics
- GPU benchmarking beyond functional acceptance checks

## Environment Assumptions

- Backend runs at `http://127.0.0.1:8000`.
- Frontend Vite dev server runs at `http://127.0.0.1:5173`.
- WebSocket stream is available at `ws://127.0.0.1:8000/ws/pitch`.
- If using an API gateway/dev proxy, map compatibility aliases as:
  - `/api/score` -> `/score`
  - `/api/tempo` -> `/playback/tempo`
  - `ws://localhost:8765` -> `ws://127.0.0.1:8000/ws/pitch`
- Playback clock source is `AudioContext.currentTime`; assertions must never use `Date.now()` as source-of-truth sync.
- Backend does **not** initiate pitch frames until playback is started and audio/pitch data is available.

## Execution Contract

- Execute scenarios in order (`IT-001` ... `IT-011`) unless explicitly marked independent.
- For each scenario:
  - stop immediately on first failed assertion;
  - record `PASS` or `FAIL` plus evidence payload (HTTP status/body, WS frame, DOM snapshot);
  - if a precondition cannot be satisfied, record `BLOCKED` and reason.

## Fixtures and Test Data

### Score fixtures

Use these repository fixtures:
- `frontend/e2e/fixtures/minimal.xml` (small deterministic score)
- `frontend/e2e/fixtures/minimal.mxl` (compressed variant)
- `musescore/homeward_bound.mxl` (real-world score with tempo metadata)

### Synthetic audio generation

Use generated mono float32 PCM data, `sample_rate = 44100`.

Reference generator (Python):

```python
import numpy as np

def sine_wave(freq_hz: float, duration_s: float, sample_rate: int = 44100, amplitude: float = 0.8):
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
```

Required signals:
- `A4_440`: 440 Hz, 0.2 s
- `C5_523`: 523.25 Hz, 0.2 s
- `SILENCE`: zeros, 0.2 s

### Hardware labels

- `hardware: false` = CI-safe.
- `hardware: true` = requires local hardware/GPU; CI-skip candidate.

---

## Scenario IT-001 — Backend startup + health endpoint

- **Boundary:** backend process + `/health`
- **hardware:** false
- **Preconditions:** backend process is running.

### Steps
1. `GET http://127.0.0.1:8000/health`.
2. Parse JSON body.

### Expected outcome
- HTTP 200.
- JSON contains keys `status` and `version`.
- `status == "ok"`.

### Pass/fail criteria
- **PASS:** all assertions true.
- **FAIL:** non-200, invalid JSON, or missing/incorrect fields.

---

## Scenario IT-002 — MusicXML upload and parse (`POST /api/score` compatibility)

- **Boundary:** HTTP upload -> parser -> score model
- **hardware:** false
- **Preconditions:** fixture file exists.

### Steps
1. Upload `frontend/e2e/fixtures/minimal.xml` with multipart form field `file` to `POST /score`.
2. (Optional compatibility check) repeat via proxy route `POST /api/score` when such alias exists.
3. Parse JSON response.

### Expected outcome
- HTTP 200.
- JSON includes `title`, `parts`, `notes`, `tempo_marks`, `time_signatures`, `total_beats`.
- `parts` length >= 1.
- `notes` length >= 1.
- Every note contains `midi`, `beat_start`, `duration`, `measure`, `part`.

### Pass/fail criteria
- **PASS:** schema + minimum counts validated.
- **FAIL:** upload error, parse error, or schema mismatch.

---

## Scenario IT-003 — WebSocket connection lifecycle (`ws://localhost:8765` compatibility)

- **Boundary:** WS handshake, status message, keepalive, shutdown
- **hardware:** false
- **Preconditions:** backend running, WS endpoint reachable.

### Steps
1. Open WS to `ws://127.0.0.1:8000/ws/pitch` (or compatibility alias `ws://localhost:8765` when proxied).
2. Read first message.
3. Without starting playback, wait up to 7 seconds for keepalive.
4. Close socket cleanly.

### Expected outcome
- First message is `{"status":"connected"}`.
- Keepalive message `{"ping": true}` received while idle.
- No unsolicited pitch frame (`t/midi/conf`) before playback start.

### Pass/fail criteria
- **PASS:** connection accepted + expected status/ping contract.
- **FAIL:** connection refusal, malformed status, or unexpected frame emission while idle.

---

## Scenario IT-004 — Pitch frame format and field validation

- **Boundary:** pitch pipeline -> WS frame serialization
- **hardware:** false
- **Preconditions:** WS connected; playback started; synthetic voiced audio pushed to pipeline test harness.

### Steps
1. Start playback via `POST /playback/start`.
2. Feed deterministic synthetic frame (`A4_440`) through backend pitch pipeline harness.
3. Read next non-status/non-ping WS message.
4. Validate fields and ranges.

### Expected outcome
- Frame matches object `{ "t": number, "midi": number, "conf": number }`.
- `t >= 0`.
- `0 <= conf <= 1`.
- `midi` finite number.

### Pass/fail criteria
- **PASS:** frame schema + numeric constraints valid.
- **FAIL:** missing keys, wrong types, out-of-range values, or no frame.

---

## Scenario IT-005 — Part selector data correctness per uploaded score

- **Boundary:** backend score parts -> frontend part options
- **hardware:** false
- **Preconditions:** frontend loaded; score upload succeeds.

### Steps
1. In browser context, upload `musescore/homeward_bound.mxl` through `#file-input`.
2. Wait for score load completion (`#score-info` populated).
3. Read options in part selector element `#part-select`.
4. Compare with backend response `parts` list from `/score` for same file.

### Expected outcome
- Frontend part options are a subset consistent with backend `parts`.
- Vocal parts are present.
- Accompaniment parts may be hidden by default but become available when accompaniment toggle is enabled.

### Pass/fail criteria
- **PASS:** selector behavior matches `parts` data contract.
- **FAIL:** missing expected parts, extra unknown parts, or inconsistent filtering behavior.

---

## Scenario IT-006 — Playback trigger to cursor sync (DOM verifiable)

- **Boundary:** frontend transport -> backend start -> cursor projection
- **hardware:** false
- **Preconditions:** frontend loaded with a score; browser audio preflight satisfied.

### Steps
1. Capture initial cursor position (`#cursor` x-position or equivalent rendered marker state).
2. Click `#btn-play`; complete preflight modal if shown.
3. Wait 1.5 seconds.
4. Capture cursor position again.
5. Click `#btn-pause`; record pause label/state.

### Expected outcome
- Cursor position advances after play.
- Pause button transitions to resume state after pause.
- No reverse cursor jump during normal forward playback.

### Pass/fail criteria
- **PASS:** cursor motion and transport state transitions are coherent.
- **FAIL:** cursor static during active playback, invalid state labels, or desync symptoms.

---

## Scenario IT-007 — Tempo change (`POST /api/tempo` compatibility): clamp + rollback

- **Boundary:** frontend tempo UI -> backend tempo endpoint -> frontend rollback
- **hardware:** false
- **Preconditions:** score loaded; transport initialized.

### Steps
1. Read current tempo percent from `#tempo-label` / tempo slider.
2. Request valid tempo change to 125% via frontend control (backend call `/playback/tempo?multiplier=1.25`, or proxy `/api/tempo`).
3. Assert UI shows 125%.
4. Force backend failure for next tempo request (e.g., intercept with HTTP 500 in browser test harness).
5. Attempt change to 50%.
6. Verify UI rolled back to previous value (125%).

### Expected outcome
- Valid request applies and persists.
- Failed request reverts UI + engine tempo to prior value.
- Invalid/non-positive multiplier to backend is rejected (HTTP 400).

### Pass/fail criteria
- **PASS:** success path updates tempo; failure path rolls back deterministically.
- **FAIL:** stale/partial UI state after failure, or missing validation.

---

## Scenario IT-008 — CPU pitch engine (librosa pYIN) expected note sequence

- **Boundary:** CPU inference correctness on deterministic synthetic signals
- **hardware:** false
- **Preconditions:** pitch engine set to CPU/pYIN path.

### Steps
1. Generate sequence `[A4_440, C5_523, SILENCE]`.
2. Run each window through CPU inference.
3. Collect emitted pitch frames.

### Expected outcome
- `A4_440` maps near MIDI 69 (tolerance ±1.0).
- `C5_523` maps near MIDI 72 (tolerance ±1.0).
- `SILENCE` yields no voiced frame (`None` / no emission).
- Any emitted frame satisfies confidence threshold used by pipeline.

### Pass/fail criteria
- **PASS:** note mapping and silence behavior match expected sequence.
- **FAIL:** wrong MIDI mapping, false positives on silence, or invalid confidence behavior.

---

## Scenario IT-009 — GPU pitch engine (torchcrepe weighted_argmax)

- **Boundary:** CUDA path functional correctness
- **hardware:** true (GPU)
- **Preconditions:** CUDA available; torchcrepe installed; backend can select torchcrepe engine.

### Steps
1. Verify CUDA availability.
2. Generate `A4_440` synthetic audio window.
3. Run torchcrepe inference using weighted_argmax decoder path.
4. Record inference latency and output frame.

### Expected outcome
- Inference returns no exception.
- Emitted MIDI near 69 (tolerance ±1.0) when voiced frame produced.
- Confidence within [0, 1].

### Pass/fail criteria
- **PASS:** GPU path returns valid output and remains within functional tolerance.
- **FAIL:** CUDA/runtime failure, decoder failure, or invalid frame fields.

---

## Scenario IT-010 — Backend emits frames only when prompted by playback/audio

- **Boundary:** architectural contract for WS emission behavior
- **hardware:** false
- **Preconditions:** backend running; WS connected.

### Steps
1. Open WS and consume status message.
2. Keep playback stopped for 5+ seconds.
3. Assert only keepalive ping(s) observed.
4. Start playback and inject voiced synthetic input.
5. Assert pitch frame(s) now observed.

### Expected outcome
- No pitch data during stopped/idle state.
- Pitch data appears only after explicit playback start + audio input.

### Pass/fail criteria
- **PASS:** WS emission obeys prompted-only contract.
- **FAIL:** unsolicited frames while idle or no frames after valid prompt/input.

---

## Scenario IT-011 — End-to-end WS pitch frame latency < 80 ms

- **Boundary:** audio input ingestion -> pitch inference -> WS frame emission
- **hardware:** false
- **Preconditions:** backend running; WS connected; playback started; CPU pitch engine active.

### Steps
1. Connect WS and start playback via `POST /playback/start`.
2. Record wall-clock timestamp `t0` immediately before injecting `A4_440` synthetic audio into the backend pitch pipeline harness.
3. Read the next non-status/non-ping WS frame; record receipt timestamp `t1`.
4. Compute `latency_ms = (t1 - t0) * 1000`.
5. Repeat steps 2–4 ten times; compute mean and p95 latency.

### Expected outcome
- Mean latency < 80 ms.
- p95 latency < 80 ms.
- All 10 frames carry valid schema (`t`, `midi`, `conf`).

### Pass/fail criteria
- **PASS:** mean and p95 both below 80 ms threshold; all frames valid.
- **FAIL:** any latency measurement >= 80 ms at p95, or invalid/missing frame.

### Notes
- Timing must be measured on the same thread that injects audio; do not use `Date.now()` across thread boundaries.
- Windows timer granularity (~15.6 ms) means single-sample measurements are unreliable — use the 10-sample p95 as the authoritative signal.
- For the GPU path, repeat this scenario with torchcrepe engine selected (`hardware: true`); GPU p95 is expected to be lower but is not separately gated.

---

## Reporting Template (for AI executor)

For each scenario, produce:

```json
{
  "id": "IT-001",
  "status": "PASS|FAIL|BLOCKED",
  "evidence": {
    "http": {"status": 200, "body": {}},
    "ws": [{"status": "connected"}],
    "dom": {"selector": "#btn-pause", "text": "Resume"}
  },
  "failure_reason": null
}
```

A run is acceptable when all `hardware: false` scenarios pass, and hardware scenarios are either passing or explicitly marked `BLOCKED` with reason `NO_GPU`/`NO_DEVICE`.
