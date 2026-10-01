/**
 * `startApi` is what both `npm run serve` and the desktop app run, so it is
 * proved here as a whole: migrations applied from the directory it is given,
 * bound to the host it is given on a port it picked, answering, and closed.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { audits, crawls, createDatabase, pages, renders } from '@seo/db';
import { CURRENT_CORPUS_VERSION } from '@seo/corpus';
import type { BlobStore } from '@seo/storage';
import { startFixtureSite } from '@seo/testkit';
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

  it('uploads every HTML body an audit crawls to the blob store it is given', async () => {
    const stored = new Map<string, Uint8Array>();
    const blobStore = {
      put: async (bytes: Uint8Array) => {
        const key = `test/${createHash('sha256').update(bytes).digest('hex')}`;
        stored.set(key, bytes);
        return key;
      },
      get: async (key: string) => stored.get(key) ?? null,
    } as BlobStore;

    const site = await startFixtureSite();
    const api = await startApi({ databaseUrl: url!, corpusDir, host: '127.0.0.1', port: 0, blobStore });
    const handle = createDatabase(url!, { max: 1, onnotice: () => {} });
    const post = (path: string, body: unknown) =>
      fetch(`${api.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let siteId: string | undefined;
    try {
      const created = await post('/sites', { name: 'blob store fixture', origin: site.origin });
      expect(created.status).toBe(201);
      siteId = ((await created.json()) as { id: string }).id;

      const submitted = await post('/audits', {
        siteId,
        corpusVersion: CURRENT_CORPUS_VERSION,
        crawl: { requestDelayMs: 0, maxPages: 10 },
      });
      expect(submitted.status).toBe(202);
      const auditId = ((await submitted.json()) as { auditId: string }).auditId;

      await expect
        .poll(async () => (await handle.db.select().from(audits).where(eq(audits.id, auditId)))[0]?.status, {
          timeout: 60_000,
          interval: 250,
        })
        .toBe('complete');

      const rows = await handle.db
        .select({ bodyKey: renders.bodyKey, bodyHash: renders.bodyHash })
        .from(renders)
        .innerJoin(pages, eq(renders.pageId, pages.id))
        .innerJoin(crawls, eq(pages.crawlId, crawls.id))
        .where(eq(crawls.auditId, auditId));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.bodyKey).not.toBeNull();
        expect(stored.has(row.bodyKey!)).toBe(true);
      }
    } finally {
      if (siteId !== undefined) await fetch(`${api.url}/sites/${siteId}`, { method: 'DELETE' });
      await handle.close();
      await api.close();
      await site.close();
    }
  }, 90_000);

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
