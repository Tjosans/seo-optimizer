/**
 * The one bridge between the app's pages and the desktop shell. The pages run
 * sandboxed with no Node access; all they may do is hear how the self-updater
 * is getting on and ask it to install a downloaded update, and — for the
 * database setup page (`public/setup.html`) and the dashboard's Settings —
 * read and change which database the app connects to. The browser dashboard
 * has no `window.seoDesktop` and shows neither.
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
  /** Show the database setup page in place of the dashboard. */
  openDatabaseSettings(): void {
    ipcRenderer.send('database:open');
  },
  database: {
    state: (): Promise<unknown> => ipcRenderer.invoke('database:state'),
    connect: (fields: unknown): Promise<unknown> => ipcRenderer.invoke('database:connect', fields),
    back(): void {
      ipcRenderer.send('database:back');
    },
    openFolder(): void {
      ipcRenderer.send('database:open-folder');
    },
    quit(): void {
      ipcRenderer.send('app:quit');
    },
  },
});
