/**
 * The desktop app's own preferences, kept in a JSON file beside `.env`. No
 * Electron here, so it is tested without a window.
 *
 * The browser dashboard keeps its theme in `localStorage`, which is per
 * origin. The desktop app serves the dashboard on a new loopback port each
 * start, so each start is a new origin and that storage starts empty; the
 * choice lives here instead, read and written through the preload bridge.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What Settings offers. `system` follows Windows and is the default. */
export type Theme = 'system' | 'light' | 'dark';

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readPreferences(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // No file yet, or one nobody can read: every preference at its default.
    return {};
  }
}

export function readTheme(file: string): Theme {
  const { theme } = readPreferences(file);
  return isTheme(theme) ? theme : 'system';
}

/** Write `theme`, keeping whatever else the file holds. */
export function saveTheme(file: string, theme: Theme): void {
  const preferences = { ...readPreferences(file), theme };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(preferences, null, 2)}\n`);
}
