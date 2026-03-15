const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const BACKEND_START_TIMEOUT_MS = 5_000;
const BACKEND_RESTART_DELAY_MS = 1_000;
const BACKEND_STOP_GRACE_MS = 2_000;

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendPort = null;
let restartTimer = null;
let shuttingDown = false;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 220,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    transparent: false,
    backgroundColor: '#101010',
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--sing-attune-backend-port=${String(port)}`],
    },
  });

  mainWindow.once('ready-to-show', () => {
    splashWindow?.close();
    splashWindow = null;
    mainWindow?.show();
  });

  const appUrl = `http://${HOST}:${port}`;
  mainWindow.loadURL(appUrl).catch((error) => {
    console.error('[electron] Failed to load renderer URL:', error);
  });
}

function resolveBackendExecutable() {
  const fromEnv = process.env.SING_ATTUNE_BACKEND_BIN;
  if (fromEnv) {
    return fromEnv;
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `sing-attune-backend${ext}`;
  const candidates = [
    path.join(process.resourcesPath, 'backend', binaryName),
    path.join(app.getAppPath(), 'backend-dist', binaryName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate backend executable. Checked: ${candidates.join(', ')}. ` +
      'Set SING_ATTUNE_BACKEND_BIN to override.',
  );
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to determine dynamic backend port.')));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}

function waitForBackendHealthy(port, timeoutMs) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(
        {
          hostname: HOST,
          port,
          path: '/health',
          timeout: 1_000,
        },
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

async function startBackend() {
  const executable = resolveBackendExecutable();
  backendPort = await findOpenPort();

  const args = ['--host', HOST, '--port', String(backendPort)];
  backendProcess = spawn(executable, args, {
    stdio: 'pipe',
    env: {
      ...process.env,
      SING_ATTUNE_BACKEND_PORT: String(backendPort),
    },
  });

  backendProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${String(chunk)}`);
  });

  backendProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${String(chunk)}`);
  });

  backendProcess.on('exit', (code, signal) => {
    const unexpected = !shuttingDown && code !== 0;
    console.error(`[electron] Backend exited (code=${code}, signal=${signal}).`);
    backendProcess = null;

    if (unexpected) {
      scheduleBackendRestart();
    }
  });

  await waitForBackendHealthy(backendPort, BACKEND_START_TIMEOUT_MS);

  process.env.SING_ATTUNE_BACKEND_PORT = String(backendPort);
}

function scheduleBackendRestart() {
  if (restartTimer || shuttingDown) {
    return;
  }

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    try {
      await startBackend();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(`http://${HOST}:${backendPort}`);
      }
    } catch (error) {
      console.error('[electron] Backend restart failed:', error);
      scheduleBackendRestart();
    }
  }, BACKEND_RESTART_DELAY_MS);
}

function stopBackend() {
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (!backendProcess || backendProcess.killed) {
    return;
  }

  backendProcess.kill('SIGTERM');

  setTimeout(() => {
    if (backendProcess && !backendProcess.killed) {
      backendProcess.kill('SIGKILL');
    }
  }, BACKEND_STOP_GRACE_MS);
}

function registerIpcHandlers() {
  ipcMain.handle('backend:get-config', () => ({
    host: HOST,
    port: backendPort,
    baseUrl: backendPort ? `http://${HOST}:${backendPort}` : null,
  }));
}

async function bootstrap() {
  createSplashWindow();
  registerIpcHandlers();

  try {
    await startBackend();
    createMainWindow(backendPort);
  } catch (error) {
    console.error('[electron] Failed to start backend:', error);
    app.quit();
  }
}

app.whenReady().then(bootstrap);
app.on('before-quit', stopBackend);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createMainWindow(backendPort);
  }
});
