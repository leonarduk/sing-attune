import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('singAttune', {
  platform: process.platform,
});
