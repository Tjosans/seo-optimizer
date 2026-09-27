/**
 * seo-optimizer as a desktop app.
 *
 *     npm run desktop            # from a checkout
 *     SEO-Optimizer-Setup-x.y.z.exe   # installed, self-updating
 *
 * One window, and behind it the same two servers `npm run serve` and
 * `npm run dashboard` start — here in this process, on loopback ports nobody
 * else can reach. The window is the dashboard; the dashboard proxies the API
 * exactly as it does in a browser, so there is one UI, not two.
 *
 * Postgres is still a server of its own: the local stack (`npm run
 * stack:up`) by default, or whatever `DATABASE_URL` says in
 * `<userData>/.env`. The app brings its schema up to date on every start,
 * because an update may carry a migration and there is nobody to run one.
 *
 * Audits are written to the `jobs` table, so quitting — or restarting into an
 * update — mid-crawl resumes the audit on the next start instead of losing it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { startApi } from '@seo/api';
import type { RunningApi } from '@seo/api';
import { createServer as createDashboard } from '@seo/dashboard';
import { createLogger } from './log.js';
import { startUpdater } from './updater.js';
import type { UpdateStatus, Updater } from './updater.js';

const PRODUCT = 'SEO Optimizer';
/** The local stack's database, as `.env.example` and docker-compose.yml have it. */
const DEFAULT_DATABASE_URL = 'postgres://seo:seo@localhost:5433/seo_optimizer';
const LOOPBACK = '127.0.0.1';

const here = dirname(fileURLToPath(import.meta.url));
/** Where the corpus, migrations and dashboard assets live, installed or not. */
const paths = app.isPackaged
  ? {
      corpus: join(process.resourcesPath, 'corpus'),
      migrations: join(process.resourcesPath, 'migrations'),
      public: join(process.resourcesPath, 'public'),
      env: join(app.getPath('userData'), '.env'),
    }
  : (() => {
      const root = join(here, '..', '..', '..');
      return {
        corpus: join(root, 'corpus'),
        migrations: join(root, 'packages', 'db', 'migrations'),
        public: join(root, 'apps', 'dashboard', 'public'),
        env: join(root, '.env'),
      };
    })();

const log = createLogger(join(app.getPath('userData'), 'logs', 'main.log'), !app.isPackaged);
process.on('uncaughtException', (error) => log.error('uncaught', error));
process.on('unhandledRejection', (error) => log.error('unhandled rejection', error));

if (!app.requestSingleInstanceLock()) {
  // A second copy would claim the same jobs; hand focus to the first instead.
  app.quit();
} else {
  void run();
}

let window: BrowserWindow | undefined;
let api: RunningApi | undefined;
let updater: Updater | undefined;
let lastStatus: UpdateStatus | null = null;

async function run(): Promise<void> {
  await app.whenReady();
  log.info(`${PRODUCT} v${app.getVersion()} starting (packaged: ${app.isPackaged})`);

  try {
    process.loadEnvFile(paths.env);
  } catch {
    // No .env: the environment, or the local stack's default below.
  }
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;

  app.on('second-instance', () => {
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());

  ipcMain.handle('update-status:get', () => lastStatus);
  ipcMain.on('update:restart-now', () => updater?.restartNow());

  // The updater starts before the database is asked for anything, so a
  // release that fixes a start-up failure can still arrive.
  updater = startUpdater({
    log,
    isIdle: () => api === undefined || api.scheduler.queued + api.scheduler.running === 0,
    onStatus: (status) => {
      lastStatus = status;
      window?.webContents.send('update-status', status);
    },
  });

  Menu.setApplicationMenu(buildMenu());

  api = await startApiUntilItRuns(databaseUrl);
  if (api === undefined) {
    app.quit();
    return;
  }

  const dashboard = createDashboard({ apiUrl: api.url, publicDir: paths.public, version: app.getVersion() });
  await new Promise<void>((resolve) => dashboard.listen(0, LOOPBACK, resolve));
  const dashboardUrl = `http://${LOOPBACK}:${(dashboard.address() as AddressInfo).port}/`;
  log.info(`api on ${api.url}, dashboard on ${dashboardUrl}`);

  window = createWindow(dashboardUrl);
}

/**
 * Starting the API is where a missing database shows itself. Rather than a
 * window full of 502s, say what is wrong and where to fix it, and try again
 * when asked.
 */
async function startApiUntilItRuns(databaseUrl: string): Promise<RunningApi | undefined> {
  for (;;) {
    try {
      return await startApi({
        databaseUrl,
        corpusDir: paths.corpus,
        migrationsDir: paths.migrations,
        jobOwner: 'desktop',
        host: LOOPBACK,
        port: 0,
      });
    } catch (error) {
      log.error('api failed to start', error);
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: PRODUCT,
        message: 'SEO Optimizer cannot reach its database.',
        detail:
          `${describe(error)}\n\n` +
          `Tried ${redact(databaseUrl)}.\n\n` +
          'Start the local stack (npm run stack:up in the repository), or put a ' +
          `DATABASE_URL line in ${paths.env}.`,
        buttons: ['Retry', 'Open settings folder', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 2) return undefined;
      if (response === 1) void shell.openPath(dirname(paths.env));
    }
  }
}

function createWindow(url: string): BrowserWindow {
  const title = `${PRODUCT} v${app.getVersion()}`;
  const win = new BrowserWindow({
    title,
    // Installed, the window takes the exe's icon; from a checkout, Electron's
    // own would show in the taskbar instead.
    ...(app.isPackaged ? {} : { icon: join(here, '..', 'build', 'icon.png') }),
    width: 1360,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The page's own <title> would replace the version in the title bar.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  // Links out of the dashboard — an audited site, a source — open in the
  // person's browser, never in a window with the app's bridge in it.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (lastStatus !== null) win.webContents.send('update-status', lastStatus);
  });
  void win.loadURL(url);
  return win;
}

function buildMenu(): Menu {
  const logFile = join(app.getPath('userData'), 'logs', 'main.log');
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => updater?.check(true), enabled: app.isPackaged },
        { type: 'separator' },
        { label: 'Open Settings Folder', click: () => void shell.openPath(dirname(paths.env)) },
        { label: 'Open Log', click: () => void (existsSync(logFile) && shell.openPath(logFile)) },
        { type: 'separator' },
        {
          label: `About ${PRODUCT}`,
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: PRODUCT,
              message: `${PRODUCT} v${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Node ${process.versions.node}`,
            }),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) return describe(error.errors[0]);
  if (error instanceof Error) return error.cause !== undefined ? describe(error.cause) : error.message;
  return String(error);
}

/** The URL as it appears in a dialog: host and database, never the password. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = parsed.password === '' ? '' : '***';
    return parsed.toString();
  } catch {
    return 'DATABASE_URL';
  }
}
