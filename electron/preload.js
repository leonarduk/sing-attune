const { contextBridge, ipcRenderer } = require('electron');

function readBackendPortFromArgv() {
  const prefix = '--sing-attune-backend-port=';
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) {
    return null;
  }

  const rawPort = match.slice(prefix.length);
  const parsed = Number.parseInt(rawPort, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

contextBridge.exposeInMainWorld('singAttune', {
  getBackendPort: () => readBackendPortFromArgv(),
  getBackendConfig: () => ipcRenderer.invoke('backend:get-config'),
});
