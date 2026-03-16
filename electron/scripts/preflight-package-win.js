const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const rootDir = path.resolve(__dirname, '..', '..');
const frontendNodeModules = path.join(rootDir, 'frontend', 'node_modules');
const glModulePath = path.join(frontendNodeModules, 'gl');
const backendDistPath = path.join(rootDir, 'dist', 'sing-attune-backend');
const iconPath = path.join(rootDir, 'electron', 'assets', 'icon.ico');
const iconBase64Path = path.join(rootDir, 'electron', 'assets', 'icon.ico.base64');

function fail(message) {
  console.error(`\n[preflight] ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[preflight] ${message}`);
}

function removeGlIfPresent() {
  if (fs.existsSync(glModulePath)) {
    fs.rmSync(glModulePath, { recursive: true, force: true });
    info('Removed frontend/node_modules/gl to avoid Windows native rebuild failure.');
    return;
  }

  info('frontend/node_modules/gl not present; nothing to remove.');
}

function verifyBackendBinaryExists() {
  if (!fs.existsSync(backendDistPath)) {
    fail('Missing dist/sing-attune-backend. Run `just build-backend` before `just package`.');
  }

  info('Found backend bundle at dist/sing-attune-backend.');
}

function materializeIconFromBase64() {
  if (fs.existsSync(iconPath) && fs.statSync(iconPath).size > 0) {
    return;
  }

  if (!fs.existsSync(iconBase64Path)) {
    fail('Missing both electron/assets/icon.ico and electron/assets/icon.ico.base64 placeholder asset.');
  }

  const encoded = fs.readFileSync(iconBase64Path, 'utf8').trim();
  if (!encoded) {
    fail('electron/assets/icon.ico.base64 is empty.');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0) {
    fail('electron/assets/icon.ico.base64 did not decode to a valid icon payload.');
  }

  fs.writeFileSync(iconPath, decoded);
  info(`Generated electron/assets/icon.ico from committed base64 placeholder (${decoded.length} bytes).`);
}

function verifyIcon() {
  materializeIconFromBase64();

  if (!fs.existsSync(iconPath)) {
    fail('Missing electron/assets/icon.ico.');
  }

  const stats = fs.statSync(iconPath);
  if (stats.size === 0) {
    fail('electron/assets/icon.ico is empty. Provide a valid 256x256 .ico file.');
  }

  info(`Found icon at electron/assets/icon.ico (${stats.size} bytes).`);
}

function verifyWindowsSymlinkPrivilege() {
  if (process.platform !== 'win32') {
    info('Skipping Developer Mode symlink check (non-Windows host).');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-attune-preflight-'));
  const target = path.join(tempDir, 'target.txt');
  const link = path.join(tempDir, 'link.txt');

  try {
    fs.writeFileSync(target, 'ok');
    fs.symlinkSync(target, link, 'file');
    info('Symlink creation succeeded.');
  } catch (error) {
    fail(
      'Could not create symlink. Enable Windows Developer Mode in Settings → System → For developers, then retry packaging.',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

removeGlIfPresent();
verifyBackendBinaryExists();
verifyIcon();
verifyWindowsSymlinkPrivilege();
info('Windows packaging preflight checks passed.');
