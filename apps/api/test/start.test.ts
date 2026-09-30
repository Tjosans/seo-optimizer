/**
 * `startApi` is what both `npm run serve` and the desktop app run, so it is
 * proved here as a whole: migrations applied from the directory it is given,
 * bound to the host it is given on a port it picked, answering, and closed.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeDatabase, startApi } from '../src/start.js';

const url = process.env['DATABASE_URL'];
const corpusDir = fileURLToPath(new URL('../../../corpus', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

describe.skipIf(!url)('startApi', () => {
  it('migrates, listens on the loopback port it picked, answers, and closes', async () => {
    const api = await startApi({ databaseUrl: url!, corpusDir, migrationsDir, host: '127.0.0.1', port: 0 });
    try {
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(new URL(api.url).port).not.toBe('0');
      const res = await fetch(`${api.url}/sites`);
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty('sites');
    } finally {
      await api.close();
    }
    expect(api.server.listening).toBe(false);
  });

  it('rejects when the database cannot be reached', async () => {
    await expect(
      startApi({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none', corpusDir, migrationsDir, port: 0 }),
    ).rejects.toThrow();
  });
});

describe('probeDatabase', () => {
  it.skipIf(!url)('resolves when the database answers', async () => {
    await expect(probeDatabase(url!)).resolves.toBeUndefined();
  });

  it('rejects, without a database, when nothing listens there', async () => {
    await expect(probeDatabase('postgres://nobody:nothing@127.0.0.1:1/none', 2)).rejects.toThrow();
  });

  it.skipIf(!url)('rejects a wrong password with what the server said', async () => {
    const wrong = new URL(url!);
    wrong.password = 'definitely-not-the-password';
    await expect(probeDatabase(wrong.toString())).rejects.toThrow(/password/i);
  });
});
