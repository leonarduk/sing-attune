/**
 * real-backend.spec.ts — issue #439
 * ===================================
 * `app.spec.ts` mocks every backend route (`/health`, `/score`, `/audio/*`,
 * `/playback/*`) and explicitly ignores `/ws/pitch` errors as "known-benign"
 * because no real backend process runs during that file's tests. That means
 * the true frontend+backend integration described in
 * `docs/integration-test-plan.md` (IT-001..IT-011) was never automated —
 * see issue #439. This file covers the foundational slice of that plan that
 * doesn't need synthetic audio injection:
 *   - IT-001: backend process + `/health`
 *   - IT-002: MusicXML upload + parse via `POST /score`
 *   - IT-003: WebSocket connection handshake only (the `{"status":"connected"}`
 *     message) — the keepalive-ping-after-7s-idle and clean-close parts of
 *     IT-003 are NOT covered here, to keep this test fast; still manual.
 *   - IT-005: part-selector options match the real `/score` response, for a
 *     single-part fixture only (see the test body for what's still missing).
 * IT-004, IT-006..IT-011 are out of scope for this file — most need a
 * synthetic-audio injection harness this PR does not add (IT-011's latency
 * budget is already covered separately in `backend/tests/test_integration.py`).
 *
 * Why beforeAll/afterAll spawn the backend instead of a second `webServer`
 * entry in playwright.config.ts: Playwright's `webServer` option (array or
 * not) starts unconditionally for the *entire* test run, with no per-file or
 * per-project scoping. Adding the Python backend there would force every e2e
 * run — including the fully-mocked app.spec.ts — to boot `uv run uvicorn`
 * and therefore depend on `uv`/Python being installed, just to run tests
 * that don't need it. Scoping the backend process to this file's own
 * beforeAll/afterAll keeps that dependency local to the one spec that
 * actually exercises it.
 *
 * Why port 8000 specifically: `frontend/vite.config.ts`'s dev-server proxy
 * hardcodes `http://127.0.0.1:8000` as the target for `/health`, `/score`,
 * `/audio`, `/playback`, `/transcribe`, `/session` and `ws://127.0.0.1:8000`
 * for `/ws`. The Playwright `webServer` in playwright.config.ts runs
 * `npm run dev` (`vite`, not `vite preview`), so that proxy is live for
 * every e2e run — the browser only ever talks to the Vite origin
 * (127.0.0.1:4173 here), and Vite's Node process forwards server-to-server.
 * That's also why no CORS_ORIGINS wiring is needed: from the browser's
 * perspective every request in this file is same-origin.
 *
 * Why soundfont CDN routes are still mocked even though this test never
 * plays audio: `score-loader`'s `loadScore()` awaits `ensureSoundfontLoaded()`
 * before calling `setSession()` (frontend/src/features/score-loader/index.ts),
 * and it's `setSession()` that synchronously triggers `connectPitchSocket()`
 * inside `frontend/src/features/pitch-overlay/index.ts`'s `onScoreLoaded`
 * handler. An unreachable soundfont CDN would therefore stall or block the
 * very WebSocket connection this file verifies, not just audio playback —
 * so the same 3 external routes app.spec.ts mocks are mocked here too.
 * `/health`, `/score`, `/audio/*`, `/playback/*` and `/ws/pitch` are
 * deliberately left unmocked; hitting the real backend is the point.
 *
 * Why `page.on('websocket', ...)` + inspecting frames rather than an
 * app-exposed connection-state signal: `frontend/src/pitch/socket.ts` only
 * exports pure message-parsing helpers, and the WebSocket owner
 * (`features/pitch-overlay/index.ts`) does not set a DOM attribute, dispatch
 * a custom event, or log anything when the socket opens or the
 * `{"status":"connected"}` message arrives — `pitchWs.onopen` only resets an
 * internal reconnect-attempt counter. There is nothing else to check, so
 * this file observes the real browser-level WebSocket directly via
 * Playwright's own API instead. See the test body for why frames are
 * collected via a `page.on('websocket', ...)` listener from the moment the
 * socket is created, rather than `page.waitForEvent('websocket')` followed
 * by a separate `ws.waitForEvent('framereceived')` call.
 *
 * Why `test.describe.configure({ mode: 'serial' })`: with `fullyParallel:
 * true` and `workers: undefined` locally, Playwright may otherwise run this
 * file's tests across multiple worker processes concurrently, and each
 * worker runs its own copy of `beforeAll`/`afterAll` — which would spawn
 * competing backend processes on the same hardcoded port 8000 (best case,
 * wasted work; worst case, one worker's `afterAll` kills the backend while
 * another worker's test still needs it). Serial mode guarantees a single
 * worker owns the whole describe block, so the backend is started once and
 * torn down once, after every test in the file has finished. This also
 * matches the integration-test-plan's own execution contract ("Execute
 * scenarios in order... unless explicitly marked independent").
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// frontend/e2e -> frontend -> repo root. `uv run` resolves `backend.main:app`
// relative to the repo root, same as CLAUDE.md's documented backend command.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8000;
const BACKEND_HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/health`;

let backendProcess: ChildProcess | null = null;
// True when a backend was already listening before beforeAll ran (e.g. a
// developer's own `just dev-backend`). Reused rather than fought over, and
// left running afterwards — mirrors playwright.config.ts's own
// webServer.reuseExistingServer convention for the Vite dev server.
let backendReused = false;

function isBackendHealthy(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(BACKEND_HEALTH_URL, { timeout: timeoutMs }, (res) => {
      res.resume(); // drain the body so the socket can close cleanly
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForBackendHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBackendHealthy(2000)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Backend at ${BACKEND_HEALTH_URL} did not become healthy within ${timeoutMs}ms`);
}

function killBackendProcess(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    // `uv run <cmd>` has no Windows equivalent of POSIX execve, so it stays
    // resident as a supervisor and launches uvicorn as a *child* process —
    // confirmed by hand while writing this test: `taskkill /pid <uvicorn-pid>`
    // reported it as a "child process of <uv.exe pid>". proc.kill() below
    // would only TerminateProcess the single PID Node gave us (uv.exe) and
    // leave the uvicorn worker running with port 8000 still held open.
    // `/T` kills the whole process tree rooted at that PID.
    const result = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    if (result.status !== 0) {
      console.warn(`taskkill for backend PID ${proc.pid} exited ${result.status}:`, result.stderr?.toString());
    }
  } else {
    proc.kill('SIGTERM');
  }
}

interface RealScoreModel {
  title: string;
  parts: string[];
  tempo_marks: { beat: number; bpm: number }[];
  total_beats: number;
}

/**
 * POST a fixture straight to the real `/score` endpoint (through the same
 * Vite dev-server proxy the browser uses) and return the parsed ScoreModel.
 * Used as ground truth so assertions below check the UI against the real
 * backend's own output instead of a second hardcoded copy of it.
 */
async function fetchRealScoreModel(
  request: import('@playwright/test').APIRequestContext,
  fixturePath: string,
  filename: string,
): Promise<RealScoreModel> {
  const res = await request.post('/score', {
    multipart: {
      file: {
        name: filename,
        mimeType: 'application/vnd.recordare.musicxml+xml',
        buffer: readFileSync(fixturePath),
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`Real /score upload failed: HTTP ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as RealScoreModel;
}

/**
 * Mirrors the exact template in frontend/src/features/score-loader/index.ts
 * (loadScore()) so the expectation is derived from the real backend
 * response, not a second hardcoded copy of it. Keep in sync if that
 * template ever changes.
 */
function formatScoreInfo(model: RealScoreModel): string {
  const bpm = model.tempo_marks[0]?.bpm ?? 120;
  return `${model.title} — ${model.parts.join(', ')} — ${bpm} bpm — ${model.total_beats.toFixed(0)} beats`;
}

/**
 * Mock ONLY the soundfont CDN routes (external, unrelated to backend
 * integration — same 3 routes app.spec.ts mocks). Deliberately does NOT
 * mock /health, /score, /audio/*, /playback/*, or /ws/pitch: this file's
 * whole point is exercising those against the real backend started below.
 */
async function mockSoundfontCdnRoutes(page: import('@playwright/test').Page): Promise<void> {
  const soundfontStub = {
    status: 200,
    contentType: 'application/javascript',
    body: 'MIDI.Soundfont.acoustic_grand_piano = {};',
  } as const;
  await page.route('**/soundfonts/**', async (route) => { await route.fulfill(soundfontStub); });
  await page.route('https://gleitz.github.io/**', async (route) => { await route.fulfill(soundfontStub); });
  await page.route('https://cdn.jsdelivr.net/**', async (route) => { await route.fulfill(soundfontStub); });
}

test.describe('real backend integration (issue #439)', () => {
  // Serial mode + rationale: see file header. 60s per test — heavier than
  // app.spec.ts's default budget because these tests round-trip through a
  // real backend process and a real WebSocket, not just page-local mocks.
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    // Cold backend start (Python import chain + FastAPI/uvicorn boot) plus
    // this hook's own polling overhead. 90s mirrors the generosity of
    // playwright.config.ts's webServer.timeout (120s) for the Vite server;
    // in practice the backend starts in a few seconds without the optional
    // torch/torchcrepe extra installed (see CLAUDE.md's Python environment
    // section) since it falls back to CPU librosa pYIN.
    test.setTimeout(90_000);

    if (await isBackendHealthy(1000)) {
      backendReused = true;
      return;
    }

    backendProcess = spawn(
      'uv',
      ['run', 'uvicorn', 'backend.main:app', '--host', BACKEND_HOST, '--port', String(BACKEND_PORT)],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No shell:true: unlike e.g. npm's .cmd shim, `uv` is a native
        // executable, so Node/libuv resolves it via PATH directly on both
        // Windows and POSIX without an intermediary shell process.
      },
    );

    let startupOutput = '';
    backendProcess.stdout?.on('data', (chunk: Buffer) => { startupOutput += chunk.toString(); });
    backendProcess.stderr?.on('data', (chunk: Buffer) => { startupOutput += chunk.toString(); });

    // Fail fast on a spawn error (e.g. ENOENT if `uv` isn't on PATH) instead
    // of silently burning the full 60s health-poll budget below on something
    // that was never going to start.
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      backendProcess?.once('error', (err) => reject(err));
    });

    try {
      await Promise.race([waitForBackendHealthy(60_000), spawnErrorPromise]);
    } catch (err) {
      console.error('=== real backend failed to become healthy; captured stdout/stderr ===\n', startupOutput);
      throw err;
    }
  });

  // Runs even if beforeAll above throws (e.g. waitForBackendHealthy's timeout):
  // Playwright marks a suite "active" the moment its beforeAll starts, and
  // guarantees a matching afterAll call for cleanup regardless of that
  // beforeAll's outcome (see @playwright/test's worker runner --
  // _runAfterAllHooksForSuite runs for any suite _runBeforeAllHooksForSuite
  // marked active, independent of success/failure). backendProcess is
  // assigned synchronously above, before the awaited health-poll that can
  // throw, so it's already set by the time this runs.
  test.afterAll(() => {
    if (backendProcess && !backendReused) {
      killBackendProcess(backendProcess);
    }
  });

  test('IT-001: GET /health reports a healthy backend', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { status?: unknown; version?: unknown };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  test('IT-002 + IT-003 (connect): uploading a real score parses via /score and opens a real pitch WebSocket', async ({ page, request }) => {
    const fixturePath = path.resolve(__dirname, 'fixtures', 'minimal.xml');
    const realScore = await fetchRealScoreModel(request, fixturePath, 'minimal.xml');

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Collect every frame from the moment the socket is created, rather than
    // waiting for the 'websocket' event and then separately calling
    // ws.waitForEvent('framereceived'). That two-step form has a real gap
    // between "socket created" and "our code gets around to attaching a
    // frame listener" — long enough in practice (page nav + OSMD render +
    // several prior `await expect()` polls) that the very first frame
    // (`{"status":"connected"}`, sent immediately on accept — see
    // backend/main.py pitch_stream()) can already be gone by the time a
    // separately-attached listener starts watching, and the *next* frame
    // observed is a `{"ping": true}` keepalive instead (sent every 5s while
    // idle — this was caught empirically while writing this test, not a
    // hypothetical). Attaching ws.on('framereceived', ...) synchronously
    // inside the page.on('websocket', ...) callback closes that gap.
    const pitchSocketFrames: string[] = [];
    let pitchSocketSeen = false;
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/ws/pitch')) return;
      pitchSocketSeen = true;
      ws.on('framereceived', (frame) => { pitchSocketFrames.push(String(frame.payload)); });
    });

    await mockSoundfontCdnRoutes(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // main.ts calls checkBackend() unconditionally at boot — a real,
    // unmocked GET /health. Asserting success here proves that path too,
    // not just the dedicated IT-001 test above.
    await expect(page.locator('#app-status-text')).toContainText('backend ok', { timeout: 10000 });
    await expect(page.locator('#error-banner')).not.toHaveClass(/visible/);

    await expect(page.locator('#score-info')).toHaveText('');

    await page.locator('#file-input').setInputFiles(fixturePath);

    // #score-info is populated from the real backend's ScoreModel JSON, via
    // the exact template score-loader uses — this breaks if either side of
    // that contract drifts. connectPitchSocket() (which creates the
    // WebSocket collected above) runs synchronously right after this, inside
    // setSession() — see frontend/src/features/score-loader/index.ts and
    // frontend/src/features/pitch-overlay/index.ts's onScoreLoaded handler.
    await expect(page.locator('#score-info')).toContainText(formatScoreInfo(realScore), { timeout: 15000 });

    await expect.poll(() => pitchSocketSeen, { timeout: 15000 }).toBe(true);
    // Assert on content, not position. The synchronous ws.on('framereceived', ...)
    // attachment above already closes the *listener-attached-too-late* gap this
    // file's header comment describes, but scanning for the specific
    // {"status":"connected"} message (rather than indexing pitchSocketFrames[0])
    // additionally makes this robust to frame *ordering* -- e.g. a slow CI host
    // scheduling the 5s-idle keepalive ping's microtask ahead of the connect
    // frame's -- without weakening what's being verified.
    await expect.poll(() => pitchSocketFrames.some((raw) => {
      try {
        return (JSON.parse(raw) as { status?: unknown }).status === 'connected';
      } catch {
        return false; // non-JSON or unrelated frame shape; keep polling
      }
    }), { timeout: 15000 }).toBe(true);

    // Stricter than app.spec.ts's IGNORED_ERRORS list: with a real backend
    // there is no known-benign /ws/pitch failure left to filter out.
    expect(consoleErrors).toEqual([]);
  });

  test('IT-005: part selector options match the real /score response', async ({ page, request }) => {
    const fixturePath = path.resolve(__dirname, 'fixtures', 'minimal.xml');
    const realScore = await fetchRealScoreModel(request, fixturePath, 'minimal.xml');

    await mockSoundfontCdnRoutes(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('#file-input').setInputFiles(fixturePath);
    await expect(page.locator('#score-info')).toContainText(realScore.title, { timeout: 15000 });

    // minimal.xml has exactly one non-accompaniment part, so this only
    // proves the trivial single-part path of getVisiblePartOptions()
    // (frontend/src/part-options.ts) is wired to the real backend response —
    // not the accompaniment show/hide filtering behaviour IT-005 also
    // describes in docs/integration-test-plan.md. That needs a multi-part
    // fixture (e.g. musescore/homeward_bound.mxl) and is left as manual /
    // follow-up work — see issue #439.
    const optionTexts = await page.locator('#part-select option').allTextContents();
    expect(optionTexts).toEqual(realScore.parts);
  });
});
