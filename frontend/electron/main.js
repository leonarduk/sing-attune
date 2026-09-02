import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/main.py's `if __name__ == "__main__":` block hardcodes its bind
// address (host="127.0.0.1", port=8000) and does not parse a --host/--port
// CLI flag or read a port env var, so the packaged backend.exe always
// listens here — it cannot be handed a dynamically-negotiated port. (The
// sibling electron/main.js pipeline *does* pass --host/--port and a
// SING_ATTUNE_BACKEND_PORT env var expecting dynamic-port support, but
// backend/main.py ignores both, so that logic is dead today against the
// current backend — not copied here; see issue #436 PR discussion for a
// possible follow-up to make the backend's port actually configurable.)
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8000;
// Backend startup includes Python/torch/torchcrepe init (GPU model load on
// first run can take several seconds), so this is deliberately generous —
// see waitForBackendHealthy().
const BACKEND_HEALTH_TIMEOUT_MS = 30_000;

let backendProcess = null;

/**
 * Spawn the PyInstaller backend binary bundled in extraResources.
 * process.resourcesPath resolves to the app's resources directory both
 * in development (node_modules/.../resources) and in the packaged installer.
 * The PyInstaller COLLECT block uses name="sing-attune-backend", so the
 * executable is sing-attune-backend.exe (Windows) / sing-attune-backend (other).
 */
function startBackend() {
  const backendDir = path.join(process.resourcesPath, 'backend');
  const backendExe = process.platform === 'win32'
    ? path.join(backendDir, 'sing-attune-backend.exe')
    : path.join(backendDir, 'sing-attune-backend');

  backendProcess = spawn(backendExe, [], {
    cwd: backendDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      // createWindow() below loads the renderer via loadFile() (a file://
      // origin), and frontend/src/services/backend.ts's apiUrl()/wsUrl()
      // helpers target this backend's http://127.0.0.1:8000 origin
      // explicitly from there, since root-relative fetch('/health') can't
      // resolve under file://. ELECTRON_MODE=1 switches the backend's CORS
      // to wildcard-allow (no credentials) so that cross-origin request is
      // actually permitted — see README.md's "ELECTRON_MODE" section and
      // issue #288, which built this specifically for a file://-origin
      // renderer but never had a caller wire it up until issue #436.
      ELECTRON_MODE: '1',
    },
  });

  backendProcess.on('error', (err) => {
    console.error(`[backend] failed to start: ${err.message}`);
    backendProcess = null;
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[backend] ${data}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[backend] ${data}`);
  });

  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });
}

function killBackend() {
  if (!backendProcess) return;
  const proc = backendProcess;
  backendProcess = null;
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
  }, 5000);
  if (timer.unref) timer.unref();
}

/**
 * Poll GET /health until the backend responds or timeoutMs elapses.
 *
 * startBackend() only spawns the process — it returns long before Python /
 * torch / uvicorn have finished initialising — and the renderer fires its
 * first fetch('/health') as soon as index.html loads. Without this wait,
 * that first call (and the /ws/pitch connection) would race a backend that
 * isn't listening yet. On timeout we still proceed to createWindow() rather
 * than quitting outright: the frontend's own checkBackend()
 * (services/backend.ts) shows a retry-able "backend unreachable" banner
 * instead of leaving the user stuck on nothing at all.
 */
function waitForBackendHealthy(timeoutMs) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(
        { hostname: BACKEND_HOST, port: BACKEND_PORT, path: '/health', timeout: 1_000 },
        (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
            return;
          }
          res.resume();
          retry();
        },
      );

      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy(new Error('Health check timeout'));
      });
    };

    const retry = () => {
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Backend failed to become healthy within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(poll, 150);
    };

    poll();
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Intentionally loadFile(), not loadURL(): nothing serves the built
  // frontend over HTTP — the backend is a pure JSON/WebSocket API (see
  // backend/main.py: no StaticFiles mount, no "/" route), so
  // loadURL(`http://${BACKEND_HOST}:${BACKEND_PORT}`) would show the
  // backend's bare 404 response instead of the app shell. vite.config.ts's
  // base: './' makes the built dist/index.html's own asset references
  // (JS/CSS) resolve correctly under this file:// origin; API and
  // WebSocket calls are handled separately via apiUrl()/wsUrl() in
  // frontend/src/services/backend.ts, which target the backend's origin
  // explicitly instead of relying on root-relative resolution. See #436.
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  startBackend();

  try {
    await waitForBackendHealthy(BACKEND_HEALTH_TIMEOUT_MS);
  } catch (error) {
    console.error('[electron] Backend did not become healthy in time:', error);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  killBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
