/**
 * The desktop app's preferences file (`preferences.ts`), without Electron:
 * the theme Settings chose has to read back on the next start, and a missing
 * or damaged file has to mean the default rather than a crash on the way up.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTheme, readTheme, saveTheme } from '../src/preferences.js';

describe('theme preference', () => {
  let dir: string | undefined;
  const file = () => {
    dir ??= mkdtempSync(join(tmpdir(), 'seo-preferences-'));
    return join(dir, 'nested', 'preferences.json');
  };
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is system when there is no file', () => {
    expect(readTheme(file())).toBe('system');
  });

  it('reads back what was saved, creating the folder', () => {
    const path = file();
    saveTheme(path, 'dark');
    expect(readTheme(path)).toBe('dark');
    saveTheme(path, 'system');
    expect(readTheme(path)).toBe('system');
  });

  it('keeps the other preferences in the file', () => {
    const path = file();
    saveTheme(path, 'light');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), other: 1 }));
    saveTheme(path, 'dark');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark', other: 1 });
  });

  it('is system when the file is damaged or holds something unknown', () => {
    const path = file();
    saveTheme(path, 'dark');
    writeFileSync(path, '{ not json');
    expect(readTheme(path)).toBe('system');
    writeFileSync(path, JSON.stringify({ theme: 'sepia' }));
    expect(readTheme(path)).toBe('system');
    writeFileSync(path, '[]');
    expect(readTheme(path)).toBe('system');
    saveTheme(path, 'light');
    expect(readTheme(path)).toBe('light');
  });

  it('knows the three themes and nothing else', () => {
    expect(['system', 'light', 'dark'].every(isTheme)).toBe(true);
    expect([undefined, null, 'Dark', 1].some(isTheme)).toBe(false);
  });
});
