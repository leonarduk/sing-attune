# Backend–Frontend Synchronisation Protocol

**Status:** Authoritative — all sync-path implementation must conform to this document.  
**Required before:** Any Day 8 code in issues #8 or #9.  
**Last updated:** 2026-03-11  

---

## 1. Clocks and the fundamental problem

Two clocks exist in the system. They are **not the same**:

| Clock | Owner | Type | Behaviour |
|---|---|---|---|
| `AudioContext.currentTime` | Frontend (Web Audio API) | Seconds, float64 | Monotonic. Advances in real time. **Never pauses, never resets.** |
| `time.monotonic()` | Backend (Python) | Seconds, float64 | Monotonic within process. Unrelated to audio context. |

The backend emits pitch frames with a `t` value in milliseconds. The frontend must be able to map that `t` value to a position in the score and to a point on the canvas. This is only possible if both sides have agreed on a shared `t = 0` anchor.

**Rule:** `t = 0` is the moment the user presses Play. At that exact moment, the frontend calls `POST /playback/start` and simultaneously begins audio scheduling. The backend records `time.monotonic()` at that instant as its epoch. `t` in all subsequent frames is `(time.monotonic() - epoch) * 1000`, in milliseconds.

---

## 2. Frame format

Every pitch frame sent over `/ws/pitch` has this shape:

```json
{ "t": 1234.5, "midi": 60.312, "conf": 0.847 }
```

| Field | Type | Semantics |
|---|---|---|
| `t` | `float` (ms) | Milliseconds since play-start. **Relative to the Play button press, not wall clock.** Range: 0 to end of piece. |
| `midi` | `float` | MIDI note number with cent detail. `60.0` = C4 exactly. `60.5` = C4 + 50 cents. |
| `conf` | `float` | Confidence 0.0–1.0. Frames with `conf < 0.6` are dropped in the backend before dispatch. The frontend will never receive a sub-threshold frame. |

Two non-frame messages may also appear on the WebSocket:

```json
{ "status": "connected" }   // sent once on connection accept
{ "ping": true }             // keepalive, sent every 5s when paused
```

The frontend must silently ignore both. Do not treat them as pitch data.

---

## 3. Play-start handshake

**Goal:** Align `t = 0` on both sides to the same physical moment.

### Sequence

```
Frontend                            Backend
   |                                   |
   |── POST /playback/start ──────────>|  backend records epoch = time.monotonic()
   |                                   |  backend → PLAYING state
   |<── { state: "PLAYING", t_ms: 0 } ─|
   |                                   |
   |  [frontend begins audio scheduling at this moment]
   |  audioStartTime = audioCtx.currentTime
   |                                   |
   |<── { t: 45.2, midi: 60.3, ... } ──|  frames begin flowing
```

### Frontend obligations at play-start

```typescript
// Record the AudioContext time at the moment play begins.
// This is the anchor for converting frame `t` to score position.
const audioStartTime = audioCtx.currentTime;  // seconds

// Convert a frame's t to AudioContext time:
function frameToAudioTime(frame_t_ms: number): number {
  return audioStartTime + (frame_t_ms / 1000);
}
```

`audioStartTime` must be stored for the lifetime of the playback session. It is reset on Stop, and re-captured on every Play (including after Stop→Play).

> **Anchor timing note:** `audioStartTime` is captured when the `POST /playback/start` **response** arrives, not when the request is sent. Meanwhile, the backend records its epoch when the **request** arrives. This means the backend's `t = 0` is systematically earlier than the frontend's `audioStartTime` by roughly half the HTTP round-trip (~1–5ms on localhost). This is within the ±50ms tolerance for local use but becomes significant if the backend and frontend ever run on separate machines. See section 6.

### Backend obligations

`POST /playback/start` records `time.monotonic()` as `_play_monotonic` and resets `_elapsed_ms = 0`. All subsequent `t` values are computed as:

```
t_ms = (_elapsed_ms + (time.monotonic() - _play_monotonic)) * 1000
```

This is already implemented in `pipeline.py`. Do not change the timing model without updating this document.

---

## 4. Pause and resume

This is the most failure-prone case. `AudioContext.currentTime` never pauses — it continues advancing while the user is paused. The backend clock **does** pause (capture stops, no new frames are emitted). On resume, both sides must re-anchor to the same continued position.

### Sequence

```
Frontend                            Backend
   |                                   |
   |── POST /playback/pause ──────────>|  _elapsed_ms += elapsed; capture stops
   |<── { state: "PAUSED", t_ms: 850 }─|
   |                                   |
   |  [user waits 5 seconds]           |
   |  audioCtx.currentTime advances    |  (silence — no frames)
   |  by 5 seconds                     |
   |                                   |
   |── POST /playback/resume ─────────>|  _play_monotonic = time.monotonic()
   |<── { state: "PLAYING", t_ms: 850}─|  backend resumes from 850ms
   |                                   |
   |  audioResumeTime = audioCtx.currentTime  (now ~5s later than audioStartTime)
```

### Frontend obligations on resume

The frontend must re-anchor so that frame `t` values remain correctly mapped to score position:

```typescript
// On receiving the resume response:
const pausedAt_ms = resumeResponse.t_ms;         // e.g. 850
const audioResumeTime = audioCtx.currentTime;    // e.g. 15.2s (5s have passed)

// New conversion: frame t → AudioContext time
function frameToAudioTime(frame_t_ms: number): number {
  const delta_ms = frame_t_ms - pausedAt_ms;
  return audioResumeTime + (delta_ms / 1000);
}
```

The original `audioStartTime` becomes stale after a pause/resume cycle and **must not be used** for mapping. Store `pausedAt_ms` and `audioResumeTime` as the new anchor pair, replacing the previous one.

### What must NOT happen

- Do not re-use `audioStartTime` after resume. The audio context time has advanced but `t` continues from 850ms. Using `audioStartTime` would map frames to positions 5 seconds ahead of where they belong.
- Do not call `audioCtx.suspend()` or `audioCtx.resume()` for sing-attune pause/resume. The audio context runs continuously; only the backend capture and frame emission pauses.

---

## 5. Seek

Seek is not yet implemented. This section defines the protocol for when it is (issue #12 transport controls).

### Sequence

```
Frontend                            Backend
   |── POST /playback/seek?t_ms=30000 >|  backend resets _elapsed_ms = 30000
   |<── { state: "PLAYING", t_ms: 30000}|  _play_monotonic = time.monotonic()
   |                                   |
   |  audioSeekTime = audioCtx.currentTime
   |  seekedTo_ms = 30000
```

### Frontend anchor after seek

```typescript
function frameToAudioTime(frame_t_ms: number): number {
  const delta_ms = frame_t_ms - seekedTo_ms;
  return audioSeekTime + (delta_ms / 1000);
}
```

Seek behaves identically to resume, except `pausedAt_ms` is replaced by the seek target position.

---

## 6. Clock skew tolerance

The backend and frontend clocks will diverge slightly over time due to:

- **Anchor offset:** `audioStartTime` is captured on response arrival; the backend epoch is set on request arrival. The systematic offset is ~half the HTTP round-trip (typically 1–5ms on localhost, potentially 10–50ms+ on a LAN or remote deployment).
- HTTP round-trip latency between `POST /playback/start` being sent and the backend recording its epoch
- Thread scheduling jitter in the Python pitch worker
- Network transmission latency on the WebSocket

**Acceptable tolerance:** ±50ms. At 20Hz (50ms frame interval), one-frame drift is imperceptible for choir practice use. Beyond 200ms the overlay dot will feel visually late.

**Remote deployment warning:** If the backend and frontend are ever hosted on separate machines, the anchor offset alone may exceed 50ms. In that case, implement a clock-sync probe before starting playback: send a `{ "type": "ping", "t": Date.now() }` message, receive a `{ "type": "pong", "server_t": ... }` response, halve the round-trip as the latency estimate, and subtract it from `audioStartTime`. Do not implement this for the current localhost-only deployment.

**Frontend compensation (recommended for Day 8):** The frontend should not attempt active clock correction. Passive compensation is sufficient: treat the WebSocket frame `t` as the source of truth for score position, and use `frameToAudioTime()` only for visual canvas positioning. Do not attempt to re-sync clocks by adjusting `AudioContext.currentTime` — this is not supported by the API.

**Future:** If drift becomes a problem in practice, a clock-sync probe (send a timestamped ping, measure round-trip, halve it as latency estimate) can be added. Do not implement this speculatively.

---

## 7. Connection lifecycle

### Initial connection

The frontend should open `/ws/pitch` once, before pressing Play. The connection persists across pause/resume. No reconnect is needed for normal operation.

### Backend restart / connection loss

If the WebSocket disconnects unexpectedly, the frontend should:

1. Display a "Reconnecting…" state to the user
2. Attempt reconnect with exponential backoff (suggested: 1s, 2s, 4s, max 10s)
3. On reconnect, call `GET /playback/state` to retrieve current `{ state, t_ms }`
4. If state is PLAYING, re-anchor as if a resume occurred at that `t_ms`
5. If state is STOPPED/PAUSED, prompt the user to restart playback

### Keepalive

The backend sends `{ "ping": true }` every 5 seconds when no frames are flowing (i.e. during PAUSED state). The frontend must not treat this as a pitch frame. Silently discard it.

---

## 8. State machine summary

```
STOPPED ──start()──> PLAYING ──pause()──> PAUSED
                        ^                    |
                        └────resume()────────┘
PLAYING ──stop()──> STOPPED
PAUSED  ──stop()──> STOPPED
```

REST endpoints and their anchor effects:

| Endpoint | Backend effect | Frontend anchor action |
|---|---|---|
| `POST /playback/start` | epoch = now; elapsed = 0 | `audioStartTime = audioCtx.currentTime` |
| `POST /playback/pause` | elapsed += elapsed; capture off | store `pausedAt_ms` from response |
| `POST /playback/resume` | epoch = now; capture on | `audioResumeTime = audioCtx.currentTime` |
| `POST /playback/stop` | elapsed = 0; teardown | clear all anchors |
| `POST /playback/seek` | elapsed = target; epoch = now | `audioSeekTime = audioCtx.currentTime; seekedTo_ms = target` |

---

## 9. Implementation checklist for Day 8

Before merging any #8 or #9 PR:

- [ ] `audioStartTime` captured at the moment `POST /playback/start` response is received
- [ ] `frameToAudioTime()` implemented and used for all canvas positioning
- [ ] Pause response `t_ms` stored as `pausedAt_ms`
- [ ] Resume recaptures `audioCtx.currentTime` as `audioResumeTime`
- [ ] `frameToAudioTime()` updated on every resume to use new anchor pair
- [ ] `{ ping: true }` and `{ status: "connected" }` messages silently discarded
- [ ] WebSocket reconnect implemented with `GET /playback/state` re-anchor
- [ ] No use of `Date.now()` anywhere in the sync path