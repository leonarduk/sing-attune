import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
