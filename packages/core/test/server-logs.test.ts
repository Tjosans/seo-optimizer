import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/inputs.js';
import { loadServerLogs, parseAccessLogLine } from '../src/server-logs.js';

const LINE =
  '203.0.113.9 - alice [10/Oct/2026:13:55:36 -0700] "GET /shop/shoes?email=a@b.c&utm=1#top HTTP/1.1" 200 2326 "https://x.test/?q=1" "Mozilla/5.0 (compatible; Googlebot/2.1)"';

describe('serverLogs', () => {
  const full = { path: 'access.log', owner: 'Jane', recordedAt: '2026-09-10T09:00:00Z' };

  it('reads a line into a hit and drops the query string', () => {
    expect(parseAccessLogLine(LINE)).toEqual({
      at: '2026-10-10T20:55:36.000Z',
      method: 'GET',
      path: '/shop/shoes',
      status: 200,
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    });
    expect(JSON.stringify(parseAccessLogLine(LINE))).not.toMatch(/alice|203\.0|email|utm|q=1/);
  });

  it('handles an absolute target and a line that is not combined format', () => {
    expect(parseAccessLogLine(LINE.replace('/shop/shoes?email=a@b.c&utm=1#top', 'http://h.test?x=1'))?.path).toBe('/');
    expect(parseAccessLogLine('not a log line')).toBeNull();
  });

  it('is strict about the section', () => {
    expect(parseInputs({ serverLogs: full }).serverLogs?.path).toBe('access.log');
    expect(() => parseInputs({ serverLogs: { ...full, path: 3 } })).toThrow(/serverLogs\.path: expected text/);
    expect(() => parseInputs({ serverLogs: { ...full, path: undefined } })).toThrow(/serverLogs\.path: required/);
    expect(() => parseInputs({ serverLogs: { ...full, extra: 1 } })).toThrow(/serverLogs\.extra: unknown field/);
  });

  it('loads hits from the file and counts skipped lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-'));
    writeFileSync(join(dir, 'access.log'), `${LINE}\n\ngarbage\n`);
    const loaded = await loadServerLogs(parseInputs({ serverLogs: full }), dir);
    expect(loaded.serverLogs?.hits).toHaveLength(1);
    expect(loaded.serverLogs?.skippedLines).toBe(1);
    await expect(loadServerLogs(parseInputs({ serverLogs: { ...full, path: 'missing.log' } }), dir)).rejects.toThrow(/server log/);
  });

  it('is in scripts/inputs.example.yaml', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const text = readFileSync(new URL('../../../scripts/inputs.example.yaml', import.meta.url), 'utf8');
    expect(parseInputs(parse(text)).serverLogs?.path).toBe('logs/access.log');
  });
});
