/**
 * Self-update from GitHub Releases.
 *
 * The installed app asks the repository's latest release whether a newer
 * version exists, downloads it in the background, and restarts itself into it
 * — no uninstall, no installer to click through. The window stays up until
 * the installer is ready to replace the files and closes it; the installer's
 * own progress window covers the few seconds until the new version opens, so
 * there is never a moment with nothing on screen. What it will not do is pull
 * the rug from under a crawl: while an audit is queued or running it holds
 * the downloaded update and says so, and installs the moment the queue is
 * empty. "Restart now" skips the wait; the audit is in the job store and
 * resumes on the next start.
 *
 * Publishing is CI's job (`.github/workflows/release.yml`): a version on
 * `master` with no release yet is built and released, and every installed
 * copy picks it up on its next check.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import type { Logger } from './log.js';

const { autoUpdater, BaseUpdater } = electronUpdater;

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
/**
 * The installer says when it is ready to replace the files, and the app says
 * when the new version's window is up, each by writing a file into %TEMP%
 * (apps/desktop/build/installer.nsh has the other half).
 */
const CLOSE_SIGNAL = join(tmpdir(), `${basename(process.execPath)}.update-close`);
const STARTED_SIGNAL = join(tmpdir(), `${basename(process.execPath)}.update-started`);
/**
 * If the installer never gives the word — it failed to start, or died —
 * quit anyway, so the update still goes in the way it did before.
 */
const INSTALLER_HANDOVER_MS = 60 * 1000;

/**
 * Called once the window is showing. After an update the installer is still
 * on screen, waiting for this before it steps aside.
 */
export function announceStarted(log: Logger): void {
  if (!app.isPackaged || !process.argv.includes('--updated')) return;
  try {
    writeFileSync(STARTED_SIGNAL, '');
  } catch (error) {
    log.warn('updater: could not tell the installer the app is up', error);
  }
}

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
    restartInto(downloaded);
  }

  let handingOver = false;

  function restartInto(version: string): void {
    clearTimeout(idleTimer);
    if (handingOver) return;
    onStatus({ state: 'restarting', version });
    log.info(`updater: installing v${version}`);
    // Not quitAndInstall, which quits the moment the installer is spawned and
    // leaves nothing on screen while it starts. The one-click installer runs
    // with its progress window showing, closes this app once it is ready to
    // replace the files, and starts the new version when it is done;
    // settings and database untouched.
    // On Windows autoUpdater is the NsisUpdater, a BaseUpdater; the check is
    // for the type, and quitAndInstall stays the way out anywhere else.
    if (!(autoUpdater instanceof BaseUpdater)) {
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    rmSync(CLOSE_SIGNAL, { force: true });
    if (!autoUpdater.install(false, true)) return;
    handingOver = true;
    const started = Date.now();
    const watch = setInterval(() => {
      if (existsSync(CLOSE_SIGNAL)) {
        log.info('updater: the installer is ready; closing');
        // exit, not quit: nothing here needs an orderly shutdown (the job
        // store is Postgres), and the installer is waiting on every process.
        app.exit(0);
      } else if (Date.now() - started > INSTALLER_HANDOVER_MS) {
        clearInterval(watch);
        log.warn('updater: no word from the installer; quitting for it');
        app.quit();
      }
    }, 100);
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
      if (downloaded !== null) restartInto(downloaded);
    },
  };
}
