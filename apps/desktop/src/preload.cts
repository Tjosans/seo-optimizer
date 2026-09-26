/**
 * The one bridge between the dashboard page and the desktop shell. The page
 * runs sandboxed with no Node access; all it may do is hear how the
 * self-updater is getting on and ask it to restart now instead of waiting.
 * The browser dashboard has no `window.seoDesktop` and shows no update line.
 */

// CommonJS, because a sandboxed preload cannot be an ES module.
import electron = require('electron');
import type { IpcRendererEvent } from 'electron';

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('seoDesktop', {
  onUpdateStatus(listener: (status: unknown) => void): void {
    ipcRenderer.on('update-status', (_event: IpcRendererEvent, status: unknown) => listener(status));
    void ipcRenderer.invoke('update-status:get').then((status: unknown) => {
      if (status !== null) listener(status);
    });
  },
  restartToUpdate(): void {
    ipcRenderer.send('update:restart-now');
  },
});
