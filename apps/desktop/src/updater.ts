/**
 * Self-update from GitHub Releases.
 *
 * The installed app asks the repository's latest release whether a newer
 * version exists, downloads it in the background, and restarts itself into it
 * — no uninstall, no installer to click through. What it will not do is pull
 * the rug from under a crawl: while an audit is queued or running it holds
 * the downloaded update and says so, and installs the moment the queue is
 * empty. "Restart now" skips the wait; the audit is in the job store and
 * resumes on the next start.
 *
 * Publishing is CI's job (`.github/workflows/release.yml`): a version on
 * `master` with no release yet is built and released, and every installed
 * copy picks it up on its next check.
 */

import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import type { Logger } from './log.js';

const { autoUpdater } = electronUpdater;

export type UpdateStatus =
  | { readonly state: 'checking' }
  | { readonly state: 'up-to-date' }
  | { readonly state: 'available'; readonly version: string }
  | { readonly state: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly state: 'waiting-for-idle'; readonly version: string }
  | { readonly state: 'restarting'; readonly version: string }
  | { readonly state: 'error'; readonly message: string };

export interface UpdaterOptions {
  readonly log: Logger;
  /** True when no audit is queued or running, so a restart costs nothing. */
  readonly isIdle: () => boolean;
  /** Told of every change, to pass on to the page's version badge. */
  readonly onStatus: (status: UpdateStatus) => void;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;
const IDLE_POLL_MS = 15 * 1000;
/** Long enough to read "restarting to install" before the window goes. */
const RESTART_NOTICE_MS = 4 * 1000;

export interface Updater {
  /** Checks now. `manual` answers "you are up to date" in a dialog too. */
  check(manual?: boolean): void;
  /** Installs a downloaded update without waiting for the queue to empty. */
  restartNow(): void;
}

export function startUpdater(options: UpdaterOptions): Updater {
  const { log, isIdle, onStatus } = options;

  // An unpackaged run has no app-update.yml to say where releases live, and
  // nothing to replace: `npm run desktop` is a checkout, updated by git.
  if (!app.isPackaged) {
    log.info('updater: not packaged, self-update disabled');
    return { check: () => void 0, restartNow: () => void 0 };
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // If the app is closed before the wait for an idle queue ends, the
  // downloaded update still goes in on the way out.
  autoUpdater.autoInstallOnAppQuit = true;

  let downloaded: string | null = null;
  // `download-progress` carries no version; remember the one announced.
  let pendingVersion = '';
  let manualCheck = false;
  let idleTimer: NodeJS.Timeout | undefined;

  autoUpdater.on('checking-for-update', () => onStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => {
    onStatus({ state: 'up-to-date' });
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox({
        type: 'info',
        message: `SEO Optimizer v${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on('update-available', (info) => {
    manualCheck = false;
    pendingVersion = info.version;
    onStatus({ state: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    onStatus({ state: 'downloading', version: pendingVersion, percent: progress.percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version;
    installWhenIdle();
  });
  autoUpdater.on('error', (error) => {
    log.error('updater:', error);
    onStatus({ state: 'error', message: error.message });
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: error.message });
    }
  });

  function installWhenIdle(): void {
    if (downloaded === null) return;
    clearTimeout(idleTimer);
    if (!isIdle()) {
      onStatus({ state: 'waiting-for-idle', version: downloaded });
      idleTimer = setTimeout(installWhenIdle, IDLE_POLL_MS);
      return;
    }
    restartInto(downloaded, RESTART_NOTICE_MS);
  }

  function restartInto(version: string, afterMs: number): void {
    clearTimeout(idleTimer);
    onStatus({ state: 'restarting', version });
    log.info(`updater: restarting into v${version}`);
    // Silent install, then relaunch: the one-click installer replaces the app
    // in place and starts the new version, settings and database untouched.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), afterMs);
  }

  const check = (manual = false): void => {
    manualCheck = manual;
    autoUpdater.checkForUpdates().catch((error: unknown) => log.error('updater: check failed', error));
  };

  check();
  setInterval(check, CHECK_EVERY_MS).unref();

  return {
    check,
    restartNow: () => {
      if (downloaded !== null) restartInto(downloaded, 0);
    },
  };
}
