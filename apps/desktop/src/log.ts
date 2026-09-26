/**
 * A packaged app has no console to read, so the main process writes to
 * `<userData>/logs/main.log` as well. Help → Open log shows it. The shape
 * matches what electron-updater accepts as its `logger`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** `echo` copies each line to stdout, for a run from a terminal. An installed app has no console to echo to. */
export function createLogger(file: string, echo: boolean): Logger {
  mkdirSync(dirname(file), { recursive: true });
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
    try {
      appendFileSync(file, line);
      if (echo) process.stdout.write(line);
    } catch {
      // A log that cannot be written must not take the app down with it.
    }
  };
  return {
    info: (...args) => write('info ', args),
    warn: (...args) => write('warn ', args),
    error: (...args) => write('error', args),
    debug: () => void 0,
  };
}
