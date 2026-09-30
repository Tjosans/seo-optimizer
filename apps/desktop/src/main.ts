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
 * `<userData>/.env`. When it does not answer, the window opens on a setup
 * page (`public/setup.html`) instead of the dashboard, where the address can
 * be changed and tried again; it is written to `.env` once it connects. The
 * app brings its schema up to date on every start, because an update may
 * carry a migration and there is nobody to run one.
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
import { probeDatabase, startApi } from '@seo/api';
import type { RunningApi } from '@seo/api';
import { createServer as createDashboard } from '@seo/dashboard';
import {
  DEFAULT_DATABASE_URL,
  describe,
  fromFields,
  redact,
  saveDatabaseUrl,
  toFields,
} from './database-settings.js';
import type { DatabaseFields } from './database-settings.js';
import { createLogger } from './log.js';
import { isTheme, readTheme, saveTheme } from './preferences.js';
import { announceStarted, startUpdater } from './updater.js';
import type { UpdateStatus, Updater } from './updater.js';

const PRODUCT = 'SEO Optimizer';
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

/** Settings the app keeps for itself: the theme (`preferences.ts`). */
const preferencesFile = join(app.getPath('userData'), 'preferences.json');

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
/** Where the dashboard is served once the API runs; undefined until then. */
let dashboardUrl: string | undefined;
/** The address the app connects to, or last tried to. */
let databaseUrl = DEFAULT_DATABASE_URL;
/** Why the last attempt to connect failed, for the setup page. */
let connectError: string | null = null;
/** DATABASE_URL came from the environment, which `.env` cannot override. */
let urlFromEnvironment = false;

async function run(): Promise<void> {
  await app.whenReady();
  log.info(`${PRODUCT} v${app.getVersion()} starting (packaged: ${app.isPackaged})`);

  urlFromEnvironment = process.env['DATABASE_URL'] !== undefined;
  try {
    process.loadEnvFile(paths.env);
  } catch {
    // No .env: the environment, or the local stack's default below.
  }
  databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;

  app.on('second-instance', () => {
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());

  ipcMain.handle('update-status:get', () => lastStatus);
  ipcMain.on('update:restart-now', () => updater?.restartNow());
  handleDatabaseSettings();
  handlePreferences();

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

  window = createWindow();
  connectError = await connect(databaseUrl);
  if (connectError !== null) showSetup();
}

/**
 * Start the API and the dashboard against `url` and show the dashboard, or
 * say why not. Starting is where a missing database shows itself; rather than
 * a window full of 502s, the caller shows the setup page with the reason.
 */
async function connect(url: string): Promise<string | null> {
  try {
    // Fails in seconds on a host that swallows packets, where the pool would wait 30.
    await probeDatabase(url);
    api = await startApi({
      databaseUrl: url,
      corpusDir: paths.corpus,
      migrationsDir: paths.migrations,
      jobOwner: 'desktop',
      host: LOOPBACK,
      port: 0,
    });
  } catch (error) {
    log.error(`could not connect to ${redact(url)}`, error);
    return describe(error);
  }

  const dashboard = createDashboard({ apiUrl: api.url, publicDir: paths.public, version: app.getVersion() });
  await new Promise<void>((resolve) => dashboard.listen(0, LOOPBACK, resolve));
  dashboardUrl = `http://${LOOPBACK}:${(dashboard.address() as AddressInfo).port}/`;
  log.info(`api on ${api.url}, dashboard on ${dashboardUrl}`);
  void window?.loadURL(dashboardUrl);
  return null;
}

function showSetup(): void {
  void window?.loadFile(join(paths.public, 'setup.html'));
}

/**
 * What the setup page may ask. Only the app's own window is answered: the
 * page it shows is either the setup page or the dashboard, and nothing else
 * can load in it (`will-navigate` below).
 */
function ours(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return window !== undefined && event.sender === window.webContents;
}

function handleDatabaseSettings(): void {
  ipcMain.handle('database:state', (event) => {
    if (!ours(event)) return null;
    return {
      fields: toFields(databaseUrl),
      defaults: toFields(DEFAULT_DATABASE_URL),
      tried: redact(databaseUrl),
      error: api === undefined ? connectError : null,
      connected: api !== undefined,
      fromEnvironment: urlFromEnvironment,
      envPath: paths.env,
      version: app.getVersion(),
    };
  });

  ipcMain.handle('database:connect', async (event, fields: DatabaseFields) => {
    if (!ours(event)) return { error: 'refused' };
    const built = fromFields(fields);
    if ('problems' in built) return built;
    const { url } = built;

    if (api !== undefined) {
      // Already running on another address: check the new one answers, save
      // it, and restart onto it. Queued and running audits are in the job
      // store and resume after the restart, as they do after an update.
      if (url === databaseUrl) {
        if (dashboardUrl !== undefined) void window?.loadURL(dashboardUrl);
        return { ok: true };
      }
      try {
        await probeDatabase(url);
      } catch (error) {
        return { error: describe(error) };
      }
      saveDatabaseUrl(paths.env, url);
      log.info(`database changed to ${redact(url)}; restarting`);
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 300);
      return { restarting: true };
    }

    databaseUrl = url;
    process.env['DATABASE_URL'] = url;
    connectError = await connect(url);
    if (connectError !== null) return { error: connectError };
    saveDatabaseUrl(paths.env, url);
    log.info(`connected to ${redact(url)}; saved to ${paths.env}`);
    return { ok: true };
  });

  ipcMain.on('database:open', (event) => {
    if (ours(event)) showSetup();
  });
  ipcMain.on('database:back', (event) => {
    if (ours(event) && dashboardUrl !== undefined) void window?.loadURL(dashboardUrl);
  });
  ipcMain.on('database:open-folder', (event) => {
    if (ours(event)) void shell.openPath(dirname(paths.env));
  });
  ipcMain.on('app:quit', (event) => {
    if (ours(event)) app.quit();
  });
}

/**
 * The theme, for the dashboard and the setup page. Asked synchronously,
 * because a page applies it before its first paint; `returnValue` is always
 * set, since a page asking synchronously waits until it is.
 */
function handlePreferences(): void {
  ipcMain.on('theme:get', (event) => {
    event.returnValue = ours(event) ? readTheme(preferencesFile) : 'system';
  });
  ipcMain.on('theme:set', (event, theme: unknown) => {
    if (!ours(event) || !isTheme(theme)) return;
    try {
      saveTheme(preferencesFile, theme);
    } catch (error) {
      log.error(`could not save the theme to ${preferencesFile}`, error);
    }
  });
}

function createWindow(): BrowserWindow {
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
  win.once('ready-to-show', () => {
    win.show();
    announceStarted(log);
  });
  // Links out of the dashboard — an audited site, a source — open in the
  // person's browser, never in a window with the app's bridge in it.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  // The window shows the dashboard or the setup page, both loaded from here;
  // a page may move within the dashboard and nowhere else.
  win.webContents.on('will-navigate', (event, target) => {
    if (dashboardUrl === undefined || !target.startsWith(dashboardUrl)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  win.webContents.on('did-finish-load', () => {
    log.info(`window loaded ${win.webContents.getURL()}`);
    if (lastStatus !== null) win.webContents.send('update-status', lastStatus);
  });
  win.webContents.on('did-start-navigation', (details) => {
    // Only page loads; the dashboard's hash routes change the URL on every click.
    if (details.isMainFrame && !details.isSameDocument) log.info(`window navigating to ${details.url}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, target) => {
    log.error(`window failed to load ${target}: ${description} (${code})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`window's renderer went away: ${details.reason}`);
  });
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
        { label: 'Database…', click: () => showSetup() },
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
