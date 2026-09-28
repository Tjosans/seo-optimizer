/**
 * Self-update from GitHub Releases.
 *
 * The installed app asks the repository's latest release whether a newer
 * version exists and downloads it in the background. It never installs on its
 * own: the version badge says the update is ready and offers a button, and
 * the person decides when. Pressed, it restarts into the new version — no
 * uninstall, no installer to click through. The window stays up until the
 * installer is ready to replace the files and closes it; the installer's own
 * progress window covers the few seconds until the new version opens, so
 * there is never a moment with nothing on screen. Pressed while an audit is
 * queued or running, it asks first; the audit is in the job store and resumes
 * on the next start either way.
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
  | { readonly state: 'ready'; readonly version: string }
  | { readonly state: 'restarting'; readonly version: string }
  | { readonly state: 'error'; readonly message: string };

export interface UpdaterOptions {
  readonly log: Logger;
  /** True when no audit is queued or running, so a restart interrupts nothing. */
  readonly isIdle: () => boolean;
  /** Told of every change, to pass on to the page's version badge. */
  readonly onStatus: (status: UpdateStatus) => void;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;
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
  /** Installs the downloaded update, asking first if an audit would be cut short. */
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
  // Installing is the person's call, including on the way out: an update
  // that went in silently on quit would be one they never chose.
  autoUpdater.autoInstallOnAppQuit = false;

  let downloaded: string | null = null;
  // `download-progress` carries no version; remember the one announced.
  let pendingVersion = '';
  let manualCheck = false;

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
    log.info(`updater: v${info.version} downloaded, waiting to be told to install`);
    onStatus({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    log.error('updater:', error);
    onStatus({ state: 'error', message: error.message });
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: error.message });
    }
  });

  async function confirmThenRestart(version: string): Promise<void> {
    if (!isIdle()) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'SEO Optimizer',
        message: `Install v${version} now?`,
        detail:
          'An audit is queued or running. The app restarts to install the update, ' +
          'and the audit picks up again once it is back.',
        buttons: ['Install now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    restartInto(version);
  }

  let handingOver = false;

  function restartInto(version: string): void {
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
  // Once an update is waiting, the hourly check would only replace its
  // button with "checking…" for a moment. A manual check still runs.
  setInterval(() => {
    if (downloaded === null) check();
  }, CHECK_EVERY_MS).unref();

  return {
    check,
    restartNow: () => {
      if (downloaded !== null) void confirmThenRestart(downloaded);
    },
  };
}
