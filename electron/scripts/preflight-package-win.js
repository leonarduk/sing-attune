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
    try {
      fs.rmSync(glModulePath, { recursive: true, force: true });
    } catch (error) {
      fail(
        `Could not remove frontend/node_modules/gl (${error.message}). Close running node/electron processes and retry packaging.`,
      );
    }

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

function isValidIco(buffer) {
  if (buffer.length < 4) {
    return false;
  }

  return buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00;
}

function readIconBufferIfPresent() {
  try {
    const stats = fs.statSync(iconPath);
    if (!stats.isFile() || stats.size === 0) {
      return null;
    }

    return fs.readFileSync(iconPath);
  } catch {
    return null;
  }
}

function materializeIconFromBase64() {
  const existingIcon = readIconBufferIfPresent();
  if (existingIcon && isValidIco(existingIcon)) {
    return;
  }

  if (!fs.existsSync(iconBase64Path)) {
    fail('Missing both electron/assets/icon.ico and electron/assets/icon.ico.base64 placeholder asset.');
  }

  const encoded = fs.readFileSync(iconBase64Path, 'utf8').trim();
  if (!encoded) {
    fail('electron/assets/icon.ico.base64 is empty.');
  }

  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
    fail('electron/assets/icon.ico.base64 contains non-base64 characters.');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0) {
    fail('electron/assets/icon.ico.base64 did not decode to a valid icon payload.');
  }

  if (!isValidIco(decoded)) {
    fail('electron/assets/icon.ico.base64 decoded, but the payload is not a valid .ico file header.');
  }

  try {
    fs.writeFileSync(iconPath, decoded);
  } catch (error) {
    fail(`Could not write electron/assets/icon.ico (${error.message}).`);
  }

  info(`Generated electron/assets/icon.ico from committed base64 placeholder (${decoded.length} bytes).`);
}

function verifyIcon() {
  materializeIconFromBase64();

  const iconBuffer = readIconBufferIfPresent();
  if (!iconBuffer) {
    fail('Missing electron/assets/icon.ico. Provide a valid 256x256 .ico file.');
  }

  if (!isValidIco(iconBuffer)) {
    fail('electron/assets/icon.ico is not a valid .ico file. Provide a valid 256x256 .ico file.');
  }

  info(`Found icon at electron/assets/icon.ico (${iconBuffer.length} bytes).`);
}

function verifyWindowsSymlinkPrivilege() {
  if (process.platform !== 'win32') {
    info('Skipping Developer Mode symlink check (non-Windows host).');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-attune-preflight-'));
  const targetDir = path.join(tempDir, 'target-dir');
  const linkDir = path.join(tempDir, 'link-dir');

  try {
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir, 'junction');
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
